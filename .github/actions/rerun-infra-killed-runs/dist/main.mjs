// apps/dispatch-broker/src/rerun-infra-killed-runs/main.ts
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

// apps/dispatch-broker/src/github-api.ts
var API_VERSION = "2026-03-10";
var GitHubApiError = class extends Error {
  status;
  data;
  constructor(message, status, data) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.data = data;
  }
};
function createGitHubApi({
  token,
  fetchImpl = fetch,
  baseUrl = "https://api.github.com"
}) {
  async function request(path, { method = "GET", body, timeoutMs = 3e4 } = {}) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": API_VERSION
        },
        ...body !== void 0 && { body: JSON.stringify(body) },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new GitHubApiError(
        // Genuinely untrusted here -- whatever fetchImpl rejected with, of
        // any shape. Every real fetch failure is Error-shaped; same
        // assumption the untyped original made without checking.
        `GitHub request transport failure: ${error.message}`,
        void 0
      );
    }
    const text = await response.text();
    let data;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { malformedBody: text.slice(0, 500) };
      }
    }
    return { status: response.status, data, headers: response.headers };
  }
  async function requestOk(path, options) {
    const response = await request(path, options);
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubApiError(
        `GitHub request failed with HTTP ${response.status}`,
        response.status,
        response.data
      );
    }
    return response.data;
  }
  return { request, requestOk };
}
function splitRepository(repository) {
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra) throw new Error("Invalid repository identity");
  return { owner, repo };
}
function repositoryPath(task) {
  const { owner, repo } = splitRepository(task.repository);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runNext() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await worker(items[index], index)
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    workers.push(runNext());
  }
  await Promise.all(workers);
  return results;
}
var FIND_RUNS_FOR_GENERATION_CREATED_BUFFER_MS = 5 * 60 * 1e3;

// apps/dispatch-broker/src/rerun-infra-killed-runs/detect.ts
function jobLooksInfraKilled(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  return job?.conclusion === "failure" && steps.length > 0 && steps.every((step) => step?.conclusion === null);
}
function runLooksInfraKilled(jobs) {
  const failedJobs = (jobs ?? []).filter(
    (job) => job?.conclusion === "failure"
  );
  return failedJobs.length > 0 && failedJobs.every(jobLooksInfraKilled);
}
function isEligibleForRerun(run2) {
  return run2?.status === "completed" && run2?.conclusion === "failure" && run2?.run_attempt === 1;
}
function selectAssociatedPullRequest(pulls) {
  const candidates = pulls ?? [];
  return candidates.find((pr) => pr.state === "open") ?? candidates[0];
}
function buildRerunCommentBody({
  runUrl,
  workflowName,
  jobNames
}) {
  const names = jobNames ?? [];
  const jobs = names.length > 0 ? names.join(", ") : "a job";
  return `${workflowName ?? "CI"}'s ${jobs} failed with every step's conclusion \`null\` -- the runner was evicted/killed at the infrastructure level (agent-lcars#536), not a real test failure. Automatically reran it once: ${runUrl}`;
}

// apps/dispatch-broker/src/rerun-infra-killed-runs/main.ts
var DEFAULT_WORKFLOW_FILE = "ci.yml";
var SCAN_WINDOW_MS = 24 * 60 * 60 * 1e3;
var MAX_LIST_PAGES = 5;
var RERUN_CONCURRENCY = 3;
function env(name, required = true) {
  const value = process.env[name];
  if (required && !value) throw new Error(`${name} is required`);
  return value ?? "";
}
async function output(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  await fs.appendFile(path, `${name}=${value}
`, "utf8");
}
async function listRecentFailedRuns(api, root, sinceIso, workflowFile) {
  const runs = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const params = new URLSearchParams({
      status: "failure",
      created: `>=${sinceIso}`,
      per_page: "100",
      page: String(page)
    });
    const data = await api.requestOk(
      `${root}/actions/workflows/${workflowFile}/runs?${params}`
    );
    const pageRuns = data.workflow_runs ?? [];
    runs.push(...pageRuns);
    if (pageRuns.length < 100) break;
  }
  return runs;
}
async function getJobs(api, root, runId) {
  const jobs = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const data = await api.requestOk(
      `${root}/actions/runs/${runId}/jobs?per_page=100&page=${page}`
    );
    const pageJobs = data.jobs ?? [];
    jobs.push(...pageJobs);
    if (pageJobs.length < 100) break;
  }
  return jobs;
}
async function findAssociatedPullRequest(api, root, headSha) {
  const pulls = await api.requestOk(
    `${root}/commits/${headSha}/pulls`
  );
  return selectAssociatedPullRequest(pulls);
}
async function rerunFailedJobs(api, root, runId) {
  await api.requestOk(`${root}/actions/runs/${runId}/rerun-failed-jobs`, {
    method: "POST"
  });
}
async function commentOnPullRequest(api, root, prNumber, body) {
  await api.requestOk(`${root}/issues/${prNumber}/comments`, {
    method: "POST",
    body: { body }
  });
}
async function processRun(api, root, run2) {
  let jobs;
  try {
    jobs = await getJobs(api, root, run2.id);
  } catch (error) {
    console.log(
      `::warning::rerun-infra-killed-runs: could not fetch jobs for run ${run2.id}: ${error.message}`
    );
    return { reran: false };
  }
  if (!runLooksInfraKilled(jobs)) return { reran: false };
  try {
    await rerunFailedJobs(api, root, run2.id);
  } catch (error) {
    console.log(
      `::warning::rerun-infra-killed-runs: could not rerun failed jobs for run ${run2.id}: ${error.message}`
    );
    return { reran: false };
  }
  console.log(
    `Reran infra-killed run ${run2.id} (attempt ${run2.run_attempt} -> ${run2.run_attempt + 1}): ${run2.html_url}`
  );
  let anchor;
  try {
    const pr = await findAssociatedPullRequest(api, root, run2.head_sha);
    anchor = pr?.number ?? 0;
    if (!pr) {
      console.log(
        `No pull request is associated with run ${run2.id}'s commit ${run2.head_sha}; skipping the audit-trail comment.`
      );
    } else {
      const body = buildRerunCommentBody({
        runUrl: run2.html_url,
        workflowName: run2.name,
        jobNames: jobs.filter((job) => job.conclusion === "failure").map((job) => job.name ?? "")
      });
      try {
        await commentOnPullRequest(api, root, pr.number, body);
      } catch (error) {
        console.log(
          `::warning::rerun-infra-killed-runs: reran run ${run2.id} but could not post the audit-trail comment: ${error.message}`
        );
      }
    }
  } catch (error) {
    console.log(
      `::warning::rerun-infra-killed-runs: reran run ${run2.id} but could not determine its associated PR (anchor unknown, recovery observation will not be reported): ${error.message}`
    );
  }
  return { reran: true, anchor };
}
async function scanAndRerun({
  api,
  repository,
  workflowFile = DEFAULT_WORKFLOW_FILE,
  now = /* @__PURE__ */ new Date()
}) {
  const root = repositoryPath({ repository });
  const since = new Date(now.getTime() - SCAN_WINDOW_MS).toISOString();
  const runs = await listRecentFailedRuns(api, root, since, workflowFile);
  const eligible = runs.filter(isEligibleForRerun);
  const outcomes = await mapWithConcurrency(
    eligible,
    RERUN_CONCURRENCY,
    (run2) => processRun(api, root, run2)
  );
  let rerunCount = 0;
  const rerunRuns = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status !== "fulfilled" || !outcome.value.reran) return;
    rerunCount += 1;
    if (outcome.value.anchor === void 0) return;
    const run2 = eligible[index];
    rerunRuns.push({
      runId: run2.id,
      runAttempt: run2.run_attempt,
      anchor: outcome.value.anchor,
      runUrl: run2.html_url
    });
  });
  return { scanned: runs.length, rerun: rerunCount, rerunRuns };
}
async function run() {
  const api = createGitHubApi({ token: env("GITHUB_TOKEN") });
  const repository = env("GITHUB_REPOSITORY");
  const workflowFile = env("WORKFLOW_FILE", false) || DEFAULT_WORKFLOW_FILE;
  const { scanned, rerun, rerunRuns } = await scanAndRerun({
    api,
    repository,
    workflowFile
  });
  console.log(
    `rerun-infra-killed-runs: scanned ${scanned} recent failed ${workflowFile} run(s), reran ${rerun}.`
  );
  await output("scanned", String(scanned));
  await output("rerun", String(rerun));
  await output("rerun-run-ids", JSON.stringify(rerunRuns));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
export {
  scanAndRerun
};
