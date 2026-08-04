// Production dispatch-broker canary lifecycle (#307, final child of epic
// #301). Reuses the SAME hardened GitHub API client and ledger parser the
// broker itself uses (dispatch-broker/github-api.mjs, dispatch-broker/
// broker.mjs) rather than a parallel implementation: create a dedicated,
// clearly-marked issue -> dispatch it through agent-router.yml's real
// `kind: 'canary'` broker path -> poll the real ledger comment to a
// terminal state -> clean up (close on success, park status:needs-human
// with evidence on failure, mirroring github-api.mjs's own failClosed/
// ensureNeedsHumanParked convention).
//
// Called by two workflows sharing this one action:
//   - dispatch-canary.yml: hourly + workflow_dispatch, no live-url probe.
//   - post-deploy-smoke.yml: chained off "Deploy console" completing,
//     supplies live-url so a broken deployed revision is caught before
//     (and instead of) exercising the broker.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  createGitHubApi,
  dispatchRouterEvent,
  ensureNeedsHumanParked,
  listAll,
  loadLedger,
  mapWithConcurrency,
  repositoryPath,
} from '../dispatch-broker/github-api.mjs';

const CANARY_MARKER = '<!-- agent-lcars:dispatch-canary:v1 -->';
const CANARY_TITLE_PREFIX = '[dispatch-canary]';
const LIVE_URL_PROBE_MAX_ATTEMPTS = 5;
const LIVE_URL_PROBE_RETRY_DELAY_MS = 15_000;
// A canary lifecycle round-trips through agent-router.yml's `broker` job
// TWICE (once to dispatch the worker for the `canary` intent, once to
// process the worker's `completion` callback), and each hop needs the
// self-hosted DEFAULT_RUNNER_LABEL fleet to pick up a fresh job. That
// pickup is normally sub-second (apps/runner-autoscaler provisions a
// runner container on an always-on host, not a VM boot -- see its own
// `runner_start_duration_seconds` metric, bucketed to a 10s ceiling), but
// fleet-capacity contention can occasionally queue a `broker` job for
// several minutes before any runner claims it. #436 (and #425, #435)
// were false-positive canary failures caused by exactly this: production
// evidence showed one hop alone taking up to ~16.6 minutes, and one
// two-hop round trip totaling ~20 minutes, while the dispatch broker
// itself completed every one of those generations successfully -- the
// ledger just hadn't caught up before this poll gave up. 25 minutes
// keeps a real, bounded budget (a genuinely wedged broker still fails
// loud) while comfortably covering the worst round trip observed so far.
const LEDGER_POLL_TIMEOUT_MS = 25 * 60 * 1000;
// Mirrors dispatch-broker/main.mjs's handleCompletion poll-until-terminal
// backoff (same start/cap/doubling shape) rather than a flat interval: start
// small so a fast-completing canary is detected quickly, double each
// attempt, and cap growth so a long wait doesn't hammer the API.
const LEDGER_POLL_BACKOFF_START_MS = 2_000;
const LEDGER_POLL_BACKOFF_MAX_MS = 15_000;
const TERMINAL_REJECTED_STATES = new Set([
  'dispatch-rejected',
  'superseded',
  'superseded-by-close',
]);
// A same-process try/catch (parkCanaryFailure in runDispatchCanary's own
// catch block) cannot survive the orchestrator's own job being killed --
// a job-level `timeout-minutes` or an operator/workflow cancellation tears
// down the whole runner process, including anything still awaiting inside
// pollCanaryLedger, before that catch block ever runs. Neither
// dispatch-canary.yml (timeout-minutes: 35) nor post-deploy-smoke.yml
// (timeout-minutes: 35) has a separate cleanup job to survive that -- this
// canary is a small, self-contained workflow, not embedded in
// deploy-console.yml's own job, so there is no natural place to split
// "verify" and "cleanup" into two jobs the way the epic design audit (#301)
// recommends for a job that also owns the production deploy itself.
//
// sweepStaleCanaries below is the deterministic-rediscovery backstop that
// design explicitly calls for instead: dispatch-canary.yml runs it, hourly,
// unconditionally, before creating its own new canary, so a killed run's
// issue is found and closed/parked within one hour at the very most --
// still "automatically cleaned up" per #307's acceptance bar, just not
// synchronously. Pinned to exactly both orchestrators' own
// timeout-minutes: 35 job budget, not padded beyond it (PR #448 review):
// GitHub Actions kills a job the instant its own runtime hits
// timeout-minutes, so an open, marked canary issue older than that value
// can ONLY mean its own orchestrator run was killed before reaching its
// cleanup path -- there is no earlier moment at which that's already
// guaranteed true, and no later one is needed. Padding this further (as
// an earlier version of this comment reasoned "comfortably beyond" the
// job budget) only shrinks the window in which an orphan is stale enough
// to sweep but not yet old enough to pass this filter -- for an orphan
// that lands in that window right before an hourly pass, the janitor
// skips it and it waits a full extra cycle, silently breaking the "next
// pass" guarantee above. Keeping this well under the hourly cadence (35
// min < 60 min) still guarantees a genuinely killed run is swept by the
// very next scheduled pass.
const STALE_CANARY_AGE_MS = 35 * 60 * 1000;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeLiveUrl(
  url,
  {
    fetchImpl = fetch,
    maxAttempts = LIVE_URL_PROBE_MAX_ATTEMPTS,
    retryDelayMs = LIVE_URL_PROBE_RETRY_DELAY_MS,
    sleepImpl = sleep,
  } = {},
) {
  let lastReason = 'never attempted';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return { ok: true, status: response.status };
      lastReason = `HTTP ${response.status}`;
    } catch (error) {
      lastReason = error.message;
    }
    if (attempt < maxAttempts) await sleepImpl(retryDelayMs);
  }
  return { ok: false, reason: lastReason };
}

function issueBody({ source, runUrl, deployRunUrl }) {
  const lines = [
    'Automated production canary for the dispatch broker (#307). Created, ' +
      'dispatched through the real dispatch broker and a dedicated no-op ' +
      'worker (`.github/workflows/agent-dispatch-canary.yml`), verified, ' +
      'and closed automatically. It never invokes a paid model, GCP ' +
      'credential, or self-hosted/privileged runner -- see ' +
      'docs/e2e-security-boundary.md.',
    '',
    `Source: ${source}`,
    `Orchestrator run: ${runUrl}`,
  ];
  if (deployRunUrl) lines.push(`Deploy run: ${deployRunUrl}`);
  lines.push('', CANARY_MARKER);
  return lines.join('\n');
}

async function createCanaryIssue(api, repository, context) {
  const root = repositoryPath({ repository });
  const timestamp = new Date().toISOString();
  const issue = await api.requestOk(`${root}/issues`, {
    method: 'POST',
    body: {
      title: `[dispatch-canary] Production dispatch broker canary — ${timestamp}`,
      body: issueBody(context),
    },
  });
  if (!Number.isSafeInteger(issue?.number)) {
    throw new Error('GitHub did not return the created canary issue number');
  }
  return issue;
}

async function dispatchRouterCanary(api, repository, issueNumber) {
  await dispatchRouterEvent(
    api,
    { repository },
    { kind: 'canary', issue: String(issueNumber) },
  );
}

// The canary issue is a public GitHub issue: any user (or a compromised
// third-party integration) can comment on it before the real broker ever
// writes its own ledger comment, including a fabricated-but-parseable
// comment containing LEDGER_MARKER and a completed/successful canary
// generation. Trusting "the first marker-bearing comment" the way an
// earlier version of this file did would let that forged comment make the
// orchestrator close the issue and report a false green even if the real
// broker never ran or genuinely failed.
//
// This is exactly the trust boundary dispatch-broker/github-api.mjs's own
// loadLedger already defends for every other ledger read in this
// codebase: exactly one marker-bearing comment is ever trusted (more than
// one is treated as an anomaly and fails closed, never "pick the first"),
// and that one comment must be authored by the same workflow identity
// (REST-shaped `github-actions[bot]` login + `type: 'Bot'` -- see
// docs/bot-identity-formats.md) every ledger write in this repo already
// uses. Do not weaken or duplicate that rule here.
const LEDGER_WORKFLOW_IDENTITY = 'github-actions[bot]';

// Shared by the live poll below and sweepStaleCanaries' one-shot read: find
// this issue's ledger comment (if any) and the 'canary'-pipeline generation
// within it. Returns undefined when no ledger comment exists yet, or none
// of its generations is the canary pipeline.
//
// Reuses dispatch-broker/github-api.mjs's own loadLedger rather than
// re-deriving its trust rule locally: exactly one marker-bearing comment is
// ever trusted (more than one is treated as an anomaly and fails closed,
// never "pick the first"), and that one comment must be authored by the
// same workflow identity (REST-shaped `github-actions[bot]` login + `type:
// 'Bot'` -- see docs/bot-identity-formats.md) every ledger write in this
// repo already uses. loadLedger also paginates its comment listing
// (listAll), unlike a raw, unpaginated `GET .../comments` call -- on a
// canary issue with more than 30 comments (GitHub's default page size), an
// unpaginated read could miss the real ledger comment entirely and silently
// defeat this trust check. Do not weaken or duplicate that rule here.
async function findCanaryGeneration(api, task) {
  const loaded = await loadLedger(api, task, LEDGER_WORKFLOW_IDENTITY, {
    createIfMissing: false,
  });
  if (!loaded) return undefined;
  const generation = loaded.ledger.generations.find(
    (candidate) => candidate.pipeline === 'canary',
  );
  return generation ? { ledger: loaded.ledger, generation } : undefined;
}

async function pollCanaryLedger(
  api,
  task,
  {
    timeoutMs = LEDGER_POLL_TIMEOUT_MS,
    sleepImpl = sleep,
    now = () => Date.now(),
  } = {},
) {
  const deadline = now() + timeoutMs;
  let delay = LEDGER_POLL_BACKOFF_START_MS;
  while (now() < deadline) {
    const found = await findCanaryGeneration(api, task);
    if (found?.generation.state === 'completed') {
      return found;
    }
    if (found && TERMINAL_REJECTED_STATES.has(found.generation.state)) {
      return { ...found, rejected: true };
    }
    await sleepImpl(delay);
    delay = Math.min(delay * 2, LEDGER_POLL_BACKOFF_MAX_MS);
  }
  throw new Error(
    'Timed out waiting for the canary dispatch ledger to reach a terminal state',
  );
}

// `message` lets a caller (sweepStaleCanaries below) supply its own success
// comment instead of the default runUrl-templated one below, while still
// sharing the same comment-then-close sequence.
async function closeCanaryIssue(api, task, { generation, runUrl, message }) {
  const root = repositoryPath(task);
  const body =
    message ??
    `✅ Canary verified: dispatch broker generation g${generation.generation} ` +
      `completed successfully (worker run ${generation.attempt?.htmlUrl ?? 'n/a'}). ` +
      `Closing automatically. Orchestrator run: ${runUrl}`;
  await api.requestOk(`${root}/issues/${task.issue}/comments`, {
    method: 'POST',
    body: { body },
  });
  await api.requestOk(`${root}/issues/${task.issue}`, {
    method: 'PATCH',
    body: { state: 'closed', state_reason: 'completed' },
  });
}

// Mirrors github-api.mjs's failClosed/ensureNeedsHumanParked convention: a
// failure is never a silent log line. The issue stays OPEN with evidence
// (not auto-closed) so a maintainer has something concrete to act on --
// cleanup only ever closes a canary that actually verified successfully.
async function parkCanaryFailure(api, task, maintainer, reason) {
  const root = repositoryPath(task);
  try {
    await api.requestOk(`${root}/issues/${task.issue}/comments`, {
      method: 'POST',
      body: {
        body:
          `🚨 Canary failed: ${reason}\n\nThis issue is left open with ` +
          'evidence instead of being auto-closed. A maintainer must ' +
          'investigate.',
      },
    });
  } catch {
    // Best-effort: the label/assignee park below is the loud signal that
    // actually matters; a lost diagnostic comment must not mask it.
  }
  await ensureNeedsHumanParked(api, task, maintainer);
}

// Deterministic-rediscovery backstop for an orchestrator run that never
// reached its own runDispatchCanary catch block (job timeout, workflow
// cancellation, runner loss -- see STALE_CANARY_AGE_MS above). Lists every
// currently open issue (a single paginated, fully-consistent listing --
// deliberately not the Search API: github-api.mjs's own discovery comment
// notes the epic design audit explicitly rejected full-text/marker search
// as a discovery mechanism because of search-index replication lag),
// filters to this canary's own title prefix plus marker, and for every
// candidate older than the threshold that is not already parked:
//   - closes it (with evidence) if its ledger already shows a successful
//     canary completion -- the orchestrator verified success but never got
//     to call closeCanaryIssue itself;
//   - otherwise parks status:needs-human, identical to parkCanaryFailure.
// A per-issue failure is recorded and reported but never blocks sweeping
// the remaining candidates -- each candidate's cleanup is independent, so
// they run concurrently rather than one at a time, bounded by
// CANARY_SWEEP_CONCURRENCY below (a "list every open issue" discovery pass
// can turn up a large stale backlog; an unbounded burst of simultaneous
// GitHub writes risks tripping secondary rate limits, per the same PR #374
// review finding dispatch-broker/main.mjs's dispatchReconcileScan already
// applies this bound for).
async function sweepOneStaleCanary(api, task, maintainer) {
  const found = await findCanaryGeneration(api, task);
  const conclusion = found?.generation?.attempt?.conclusion;
  if (found?.generation.state === 'completed' && conclusion === 'success') {
    await closeCanaryIssue(api, task, {
      generation: found.generation,
      message:
        "🧹 Swept by the scheduled canary janitor: this canary's own " +
        'orchestrator run never returned (job timeout or workflow ' +
        'cancellation), but its dispatch broker ledger shows ' +
        `generation g${found.generation.generation} completed ` +
        'successfully. Closing.',
    });
    return { issue: task.issue, outcome: 'closed' };
  }
  await parkCanaryFailure(
    api,
    task,
    maintainer,
    "Swept by the scheduled canary janitor: this canary's own " +
      'orchestrator run never returned (job timeout or workflow ' +
      'cancellation) and its dispatch broker ledger never reached ' +
      'a successful terminal state.',
  );
  return { issue: task.issue, outcome: 'parked' };
}

// See the comment above sweepOneStaleCanary for why this is bounded.
const CANARY_SWEEP_CONCURRENCY = 5;

async function sweepStaleCanaries(
  api,
  repository,
  repositoryId,
  maintainer,
  { now = () => Date.now(), ageMs = STALE_CANARY_AGE_MS } = {},
) {
  const root = repositoryPath({ repository });
  const openIssues = await listAll(api, `${root}/issues?state=open`);
  const stale = openIssues.filter((issue) => {
    if (issue.pull_request) return false;
    if (!issue.title?.startsWith(CANARY_TITLE_PREFIX)) return false;
    if (!issue.body?.includes(CANARY_MARKER)) return false;
    const ageMsActual = now() - Date.parse(issue.created_at);
    return Number.isFinite(ageMsActual) && ageMsActual >= ageMs;
  });
  const toSweep = stale.filter(
    (issue) =>
      !(issue.labels ?? []).some(
        (label) =>
          (typeof label === 'string' ? label : label.name) ===
          'status:needs-human',
      ),
  );

  const outcomes = await mapWithConcurrency(
    toSweep,
    CANARY_SWEEP_CONCURRENCY,
    (issue) =>
      sweepOneStaleCanary(
        api,
        { repositoryId, repository, issue: issue.number },
        maintainer,
      ),
  );
  return outcomes.map((outcome, index) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : {
          issue: toSweep[index].number,
          outcome: 'error',
          error: outcome.reason.message,
        },
  );
}

async function runDispatchCanary({
  api,
  repository,
  repositoryId,
  maintainer,
  source,
  runUrl,
  deployRunUrl,
  liveUrl,
  probeOptions = {},
  pollOptions = {},
}) {
  if (liveUrl) {
    const probe = await probeLiveUrl(liveUrl, probeOptions);
    if (!probe.ok) {
      // No canary issue exists yet to attach evidence to; create one so
      // this failure gets the same anchored, needs-human-parked audit
      // trail as every other broker failure instead of a silent log line.
      // A broken deploy is not the broker's fault, so the canary dispatch
      // itself is deliberately skipped -- it would only be misleading.
      const issue = await createCanaryIssue(api, repository, {
        source,
        runUrl,
        deployRunUrl,
      });
      const task = { repositoryId, repository, issue: issue.number };
      const reason = `Live URL probe failed for ${liveUrl}: ${probe.reason}`;
      await parkCanaryFailure(api, task, maintainer, reason);
      throw new Error(`Post-deploy smoke: ${reason}`);
    }
  }

  const issue = await createCanaryIssue(api, repository, {
    source,
    runUrl,
    deployRunUrl,
  });
  const task = { repositoryId, repository, issue: issue.number };

  try {
    await dispatchRouterCanary(api, repository, issue.number);
    const result = await pollCanaryLedger(api, task, pollOptions);
    const conclusion = result.generation?.attempt?.conclusion;
    if (result.rejected || conclusion !== 'success') {
      throw new Error(
        `Canary dispatch generation g${result.generation?.generation} ended ` +
          `in state '${result.generation?.state}'` +
          (conclusion ? ` with conclusion '${conclusion}'` : '') +
          '.',
      );
    }
    await closeCanaryIssue(api, task, {
      generation: result.generation,
      runUrl,
    });
    return { issue: issue.number };
  } catch (error) {
    await parkCanaryFailure(api, task, maintainer, error.message);
    throw error;
  }
}

async function main() {
  const api = createGitHubApi({ token: env('GITHUB_TOKEN') });
  const repository = env('GITHUB_REPOSITORY');
  const repositoryId = Number(env('GITHUB_REPOSITORY_ID'));
  const maintainer = env('MAINTAINER_LOGIN');
  const source = env('CANARY_SOURCE');
  const runUrl = `${env('GITHUB_SERVER_URL')}/${repository}/actions/runs/${env('GITHUB_RUN_ID')}`;
  const deployRunUrl = env('DEPLOY_RUN_URL', false);
  const liveUrl = env('LIVE_URL', false);
  const sweepStale = env('SWEEP_STALE', false) === 'true';

  // The sweep is entirely best-effort with respect to the primary canary
  // below: a listing failure (e.g. a transient GitHub API error) is caught
  // here, not just a per-issue failure inside sweepStaleCanaries itself, so
  // an unhealthy janitor pass can never prevent this run's own primary
  // canary from creating, dispatching, and verifying. Any sweep problem is
  // still surfaced loudly -- just after the primary result, never instead
  // of it.
  let sweepError;
  if (sweepStale) {
    try {
      const swept = await sweepStaleCanaries(
        api,
        repository,
        repositoryId,
        maintainer,
      );
      const sweepFailures = swept.filter((entry) => entry.outcome === 'error');
      for (const entry of swept) {
        const marker = entry.outcome === 'error' ? '::error::' : '::notice::';
        const detail = entry.error ? ` (${entry.error})` : '';
        console.log(
          `${marker}canary janitor: #${entry.issue} ${entry.outcome}${detail}`,
        );
      }
      if (sweepFailures.length > 0) {
        sweepError = new Error(
          `Canary janitor sweep failed for ${sweepFailures.length} issue(s): ` +
            sweepFailures.map((entry) => `#${entry.issue}`).join(', '),
        );
      }
    } catch (error) {
      console.log(`::error::canary janitor sweep aborted: ${error.message}`);
      sweepError = error;
    }
  }

  const result = await runDispatchCanary({
    api,
    repository,
    repositoryId,
    maintainer,
    source,
    runUrl,
    deployRunUrl,
    liveUrl,
  });
  await output('issue', String(result.issue));

  // The primary canary lifecycle above always gets to run and report its
  // own outcome first; a sweep failure still fails this job loud afterward
  // rather than silently -- cleanup failure is itself a red required job,
  // same convention as the primary canary's own parkCanaryFailure path.
  if (sweepError) throw sweepError;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

export {
  CANARY_SWEEP_CONCURRENCY,
  closeCanaryIssue,
  createCanaryIssue,
  dispatchRouterCanary,
  issueBody,
  parkCanaryFailure,
  pollCanaryLedger,
  probeLiveUrl,
  runDispatchCanary,
  STALE_CANARY_AGE_MS,
  sweepStaleCanaries,
};
