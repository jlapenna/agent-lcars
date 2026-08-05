// Scheduled scan for agent-lcars#536: find recent completed-`failure` runs
// of ci.yml (the only workflow whose job -- "Verify" -- is an actual
// required status check per the "Protect main" ruleset; "E2E" runs in the
// same workflow but is not required) that show the all-null-steps
// infra-killed signature detect.mjs describes, rerun each exactly once via
// the same rerun-failed-jobs call `gh run rerun --failed` makes, and post
// an audit-trail comment on the run's associated pull request.
//
// Reuses the SAME hardened GitHub API client dispatch-broker/github-api.mjs
// already provides (createGitHubApi, repositoryPath) rather than a parallel
// implementation -- the same convention run-dispatch-canary/run.mjs
// follows for the same reason.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  createGitHubApi,
  mapWithConcurrency,
  repositoryPath,
} from '../dispatch-broker/github-api.mjs';
import {
  buildRerunCommentBody,
  isEligibleForRerun,
  runLooksInfraKilled,
  selectAssociatedPullRequest,
} from './detect.mjs';

// The scan is deliberately scoped to ONE workflow (action input
// `workflow-file`, env WORKFLOW_FILE) rather than every workflow in the
// repo - in this repo that's ci.yml, whose "Verify" job is the required
// status check per the "Protect main" ruleset; a consumer names its own
// required-check workflow instead.
const DEFAULT_WORKFLOW_FILE = 'ci.yml';

// Comfortably wider than this workflow's own ~30-minute scheduled cadence
// (see rerun-infra-killed-runs.yml's cron) so a run is never missed just
// because a scan was skipped or delayed -- an overnight gap, a transient
// API error on the previous pass, GitHub scheduling jitter. Bounded rather
// than unbounded so a long-quiet repo doesn't re-walk its entire failure
// history on every pass; isEligibleForRerun's run_attempt guard already
// makes re-examining the same run on every pass within this window free of
// any duplicate-rerun risk.
const SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;

// Mirrors dispatch-broker/github-api.mjs's own
// FIND_RUNS_FOR_GENERATION_MAX_PAGES bound: a real safety cap on
// pagination, not a number expected to be reached in practice (100
// runs/page * 5 pages = 500 runs, far more than this repo produces inside
// one SCAN_WINDOW_MS).
const MAX_LIST_PAGES = 5;

// Small and bounded, same rationale as dispatch-broker/main.mjs's own
// RECONCILE_DISPATCH_CONCURRENCY: each eligible run's own handling below
// (a jobs fetch, a rerun-failed-jobs call, a PR lookup, a comment) is a
// short sequence of independent GitHub writes/reads, and a bare
// Promise.all across every eligible run in a pass would burst all of them
// at once and risk tripping GitHub's secondary rate limits. This still
// drains a real backlog within one scan rather than one run at a time.
const RERUN_CONCURRENCY = 3;

function env(name, required = true) {
  const value = process.env[name];
  if (required && !value) throw new Error(`${name} is required`);
  return value ?? '';
}

async function output(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  await fs.appendFile(path, `${name}=${value}\n`, 'utf8');
}

async function listRecentFailedRuns(api, root, sinceIso, workflowFile) {
  const runs = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const params = new URLSearchParams({
      status: 'failure',
      created: `>=${sinceIso}`,
      per_page: '100',
      page: String(page),
    });
    const data = await api.requestOk(
      `${root}/actions/workflows/${workflowFile}/runs?${params}`,
    );
    const pageRuns = data.workflow_runs ?? [];
    runs.push(...pageRuns);
    if (pageRuns.length < 100) break;
  }
  return runs;
}

// ci.yml only ever declares two jobs (Verify, E2E), so a single
// per_page=100 page always covers every job a run of it can have -- no
// pagination loop needed the way listRecentFailedRuns has one.
async function getJobs(api, root, runId) {
  const data = await api.requestOk(
    `${root}/actions/runs/${runId}/jobs?per_page=100`,
  );
  return data.jobs ?? [];
}

async function findAssociatedPullRequest(api, root, headSha) {
  const pulls = await api.requestOk(`${root}/commits/${headSha}/pulls`);
  return selectAssociatedPullRequest(pulls);
}

async function rerunFailedJobs(api, root, runId) {
  await api.requestOk(`${root}/actions/runs/${runId}/rerun-failed-jobs`, {
    method: 'POST',
  });
}

async function commentOnPullRequest(api, root, prNumber, body) {
  await api.requestOk(`${root}/issues/${prNumber}/comments`, {
    method: 'POST',
    body: { body },
  });
}

// Each candidate is handled independently and defensively -- a single
// run's jobs-fetch, rerun, or comment failure must never stop the scan
// from examining the rest of the batch (mirrors the
// verify-then-decide/never-let-one-candidate-block-the-sweep convention
// dispatch-broker's own reconcile scan and report-failure.sh both follow).
async function processRun(api, root, run) {
  let jobs;
  try {
    jobs = await getJobs(api, root, run.id);
  } catch (error) {
    console.log(
      `::warning::rerun-infra-killed-runs: could not fetch jobs for run ${run.id}: ${error.message}`,
    );
    return { reran: false };
  }

  if (!runLooksInfraKilled(jobs)) return { reran: false };

  try {
    await rerunFailedJobs(api, root, run.id);
  } catch (error) {
    console.log(
      `::warning::rerun-infra-killed-runs: could not rerun failed jobs for run ${run.id}: ${error.message}`,
    );
    return { reran: false };
  }
  console.log(
    `Reran infra-killed run ${run.id} (attempt ${run.run_attempt} -> ${run.run_attempt + 1}): ${run.html_url}`,
  );

  try {
    const pr = await findAssociatedPullRequest(api, root, run.head_sha);
    if (!pr) {
      console.log(
        `No pull request is associated with run ${run.id}'s commit ${run.head_sha}; skipping the audit-trail comment.`,
      );
    } else {
      const body = buildRerunCommentBody({
        runUrl: run.html_url,
        workflowName: run.name,
        jobNames: jobs
          .filter((job) => job.conclusion === 'failure')
          .map((job) => job.name),
      });
      await commentOnPullRequest(api, root, pr.number, body);
    }
  } catch (error) {
    console.log(
      `::warning::rerun-infra-killed-runs: reran run ${run.id} but could not post the audit-trail comment: ${error.message}`,
    );
  }

  return { reran: true };
}

async function scanAndRerun({
  api,
  repository,
  workflowFile = DEFAULT_WORKFLOW_FILE,
  now = new Date(),
}) {
  const root = repositoryPath({ repository });
  const since = new Date(now.getTime() - SCAN_WINDOW_MS).toISOString();
  const runs = await listRecentFailedRuns(api, root, since, workflowFile);
  const eligible = runs.filter(isEligibleForRerun);

  // processRun never throws (every step inside it is already its own
  // try/catch), so every outcome here is 'fulfilled' -- the allSettled
  // shape is kept only because mapWithConcurrency always returns it.
  const outcomes = await mapWithConcurrency(
    eligible,
    RERUN_CONCURRENCY,
    (run) => processRun(api, root, run),
  );
  const rerunCount = outcomes.filter(
    (outcome) => outcome.status === 'fulfilled' && outcome.value.reran,
  ).length;

  return { scanned: runs.length, rerun: rerunCount };
}

async function run() {
  const api = createGitHubApi({ token: env('GITHUB_TOKEN') });
  const repository = env('GITHUB_REPOSITORY');
  const workflowFile = env('WORKFLOW_FILE', false) || DEFAULT_WORKFLOW_FILE;
  const { scanned, rerun } = await scanAndRerun({
    api,
    repository,
    workflowFile,
  });
  console.log(
    `rerun-infra-killed-runs: scanned ${scanned} recent failed ${workflowFile} run(s), reran ${rerun}.`,
  );
  await output('scanned', String(scanned));
  await output('rerun', String(rerun));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}

export { scanAndRerun };
