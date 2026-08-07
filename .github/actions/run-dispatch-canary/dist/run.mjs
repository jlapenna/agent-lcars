// apps/dispatch-broker/src/canary/run.ts
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

// libs/dispatch-contracts/src/ledger.ts
var LEDGER_MARKER = "<!-- agent-lcars:dispatch-ledger:v1 -->";
var LEDGER_SCHEMA = "agent-lcars.dispatch-ledger/v1";
var LEDGER_GENERATION_STATES = [
  "accepted",
  "pending",
  "dispatching",
  "dispatch-unknown",
  "dispatch-rejected",
  "active",
  "completion-observed",
  "completion-awaiting-terminal",
  "completed",
  "superseded",
  "superseded-by-close"
];
var LEDGER_ACTIVE_GENERATION_STATES = /* @__PURE__ */ new Set([
  "dispatching",
  "dispatch-unknown",
  "active",
  "completion-observed",
  "completion-awaiting-terminal"
]);
var LEDGER_JSON_BLOCK_RE = /```json([\s\S]*?)```/gu;
function renderLedgerComment(ledger, summary) {
  return `${LEDGER_MARKER}
${summary}

<details><summary>Machine state</summary>

\`\`\`json
${JSON.stringify(ledger)}
\`\`\`

</details>`;
}
function extractLedgerComment(body) {
  if (typeof body !== "string" || !body.includes(LEDGER_MARKER)) {
    return { ok: false, reason: "no-marker" };
  }
  const matches = [...body.matchAll(LEDGER_JSON_BLOCK_RE)];
  if (matches.length !== 1) {
    return { ok: false, reason: "block-count", blocks: matches.length };
  }
  try {
    return { ok: true, ledger: JSON.parse(matches[0][1]) };
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
}
var GENERATION_STATES = new Set(
  LEDGER_GENERATION_STATES
);

// apps/dispatch-broker/src/modules/ledger-core.ts
var ACTIVE_STATES = LEDGER_ACTIVE_GENERATION_STATES;
function assertTaskRef(task) {
  const candidate = task;
  if (!candidate || !Number.isSafeInteger(candidate.repositoryId) || candidate.repositoryId <= 0 || // .test() coerces a non-string argument via ToString same as this cast
  // would -- the cast changes no behavior, it only satisfies the compiler.
  !/^[^/]+\/[^/]+$/u.test(candidate.repository) || !Number.isSafeInteger(candidate.issue) || candidate.issue <= 0) {
    throw new Error("Invalid canonical TaskRef");
  }
}
function createLedger(task, now = (/* @__PURE__ */ new Date()).toISOString()) {
  assertTaskRef(task);
  return {
    schema: LEDGER_SCHEMA,
    revision: 0,
    task: structuredClone(task),
    createdAt: now,
    updatedAt: now,
    control: { closed: false },
    sources: [],
    generations: [],
    anomalies: []
  };
}
function validateLedger(ledger, task) {
  const candidate = ledger;
  if (!candidate || candidate.schema !== LEDGER_SCHEMA) {
    throw new Error("Malformed dispatch ledger: unsupported schema");
  }
  assertTaskRef(candidate.task);
  assertTaskRef(task);
  if (candidate.task.repositoryId !== task.repositoryId || candidate.task.repository.toLowerCase() !== task.repository.toLowerCase() || candidate.task.issue !== task.issue) {
    throw new Error("Malformed dispatch ledger: canonical TaskRef mismatch");
  }
  if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 0) {
    throw new Error("Malformed dispatch ledger: invalid revision");
  }
  if (!Array.isArray(candidate.sources) || !Array.isArray(candidate.generations)) {
    throw new Error("Malformed dispatch ledger: missing history");
  }
  const active = candidate.generations.filter(
    (generation) => ACTIVE_STATES.has(generation.state)
  );
  const pending = candidate.generations.filter(
    (generation) => generation.state === "pending"
  );
  if (active.length > 1 || pending.length > 1) {
    throw new Error(
      "Malformed dispatch ledger: invalid active/pending cardinality"
    );
  }
  return candidate;
}

// apps/dispatch-broker/src/broker.ts
function parseLedgerComment(body, task) {
  const extraction = extractLedgerComment(body);
  if (!extraction.ok) {
    if (extraction.reason === "no-marker") {
      throw new Error("Dispatch ledger marker missing");
    }
    if (extraction.reason === "block-count") {
      throw new Error("Malformed dispatch ledger: expected one JSON block");
    }
    throw new Error("Malformed dispatch ledger: invalid JSON");
  }
  return validateLedger(extraction.ledger, task);
}
function visibleSummary(ledger) {
  const active = ledger.generations.find(
    (generation) => ACTIVE_STATES.has(generation.state)
  );
  const pending = ledger.generations.find(
    (generation) => generation.state === "pending"
  );
  const closed = ledger.control.closed ? " \xB7 anchor closed" : "";
  if (active) {
    const run = active.attempt?.runId ? ` \xB7 run ${active.attempt.runId}` : "";
    const queued = pending ? ` \xB7 pending g${pending.generation}` : "";
    return `Dispatch broker: g${active.generation} ${active.pipeline} is ${active.state}${run}${queued}${closed}.`;
  }
  const latest = ledger.generations.at(-1);
  return latest ? `Dispatch broker: g${latest.generation} is ${latest.state}${closed}.` : `Dispatch broker: waiting for an authorized intent${closed}.`;
}
function renderLedgerComment2(ledger) {
  return renderLedgerComment(ledger, visibleSummary(ledger));
}

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
async function listAll(api, path) {
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const data = await api.requestOk(
      `${path}${separator}per_page=100&page=${page}`
    );
    if (!Array.isArray(data))
      throw new Error("GitHub pagination response is not an array");
    all.push(...data);
    if (data.length < 100) return all;
  }
  throw new Error("GitHub pagination exceeded safety bound");
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
var CLOSED_SWEEP_WINDOW_MS = 24 * 60 * 60 * 1e3;
async function loadLedger(api, task, workflowIdentity = "github-actions[bot]", { createIfMissing = true } = {}) {
  const root = repositoryPath(task);
  const comments = await listAll(
    api,
    `${root}/issues/${task.issue}/comments`
  );
  const candidates = comments.filter(
    (comment2) => comment2.body?.includes(LEDGER_MARKER)
  );
  if (candidates.length > 1) {
    throw new Error("Duplicate dispatch ledger comments");
  }
  if (candidates.length === 1) {
    const comment2 = candidates[0];
    if (comment2.user?.login !== workflowIdentity || comment2.user?.type !== "Bot") {
      throw new Error("Dispatch ledger author is not the workflow identity");
    }
    return {
      comment: comment2,
      ledger: parseLedgerComment(comment2.body, task),
      created: false
    };
  }
  if (!createIfMissing) return void 0;
  const ledger = createLedger(task);
  const comment = await api.requestOk(
    `${root}/issues/${task.issue}/comments`,
    {
      method: "POST",
      body: { body: renderLedgerComment2(ledger) }
    }
  );
  if (!Number.isSafeInteger(comment?.id)) {
    throw new Error("GitHub did not return the created ledger comment ID");
  }
  return { comment, ledger, created: true, existingComments: comments };
}
function validateDispatchResponse(response, task) {
  if (response.status !== 200) {
    throw new GitHubApiError(
      `Workflow dispatch returned HTTP ${response.status}`,
      response.status,
      response.data
    );
  }
  const data = response.data;
  const runId = data?.workflow_run_id;
  const runUrl = data?.run_url;
  const htmlUrl = data?.html_url;
  const { owner, repo } = splitRepository(task.repository);
  const expectedRunUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`;
  const expectedHtmlUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
  if (!Number.isSafeInteger(runId) || // isSafeInteger's signature accepts `unknown` but does not narrow it --
  // same posture as ledger-core.ts's assertTaskRef, which casts for the
  // same reason immediately after an identical guard.
  runId <= 0 || typeof runUrl !== "string" || runUrl !== expectedRunUrl || typeof htmlUrl !== "string" || htmlUrl !== expectedHtmlUrl) {
    throw new GitHubApiError(
      "Workflow dispatch returned malformed run details",
      200,
      response.data
    );
  }
  return { runId, runUrl, htmlUrl };
}
async function dispatchRouterEvent(api, task, inputs) {
  const response = await api.request(
    `${repositoryPath(task)}/actions/workflows/agent-router.yml/dispatches`,
    {
      method: "POST",
      body: { ref: "main", inputs }
    }
  );
  return validateDispatchResponse(response, task);
}
var FIND_RUNS_FOR_GENERATION_CREATED_BUFFER_MS = 5 * 60 * 1e3;
async function issueHasLabel(api, task, label) {
  const issue = await api.requestOk(
    `${repositoryPath(task)}/issues/${task.issue}`
  );
  return (issue.labels ?? []).some(
    (entry) => (typeof entry === "string" ? entry : entry.name) === label
  );
}
async function issueHasAssignee(api, task, login) {
  const issue = await api.requestOk(
    `${repositoryPath(task)}/issues/${task.issue}`
  );
  return (issue.assignees ?? []).some((assignee) => assignee.login === login);
}
async function mutateOrVerify(mutate2, verify) {
  try {
    await mutate2();
  } catch (error) {
    if (!await verify()) throw error;
  }
}
async function ensureNeedsHumanParked(api, task, maintainer) {
  const root = repositoryPath(task);
  await mutateOrVerify(
    () => api.requestOk(`${root}/issues/${task.issue}/labels`, {
      method: "POST",
      body: { labels: ["status:needs-human"] }
    }),
    () => issueHasLabel(api, task, "status:needs-human")
  );
  if (!maintainer) return;
  await mutateOrVerify(
    () => api.requestOk(`${root}/issues/${task.issue}/assignees`, {
      method: "POST",
      body: { assignees: [maintainer] }
    }),
    () => issueHasAssignee(api, task, maintainer)
  );
}

// apps/dispatch-broker/src/canary/run.ts
var CANARY_MARKER = "<!-- agent-lcars:dispatch-canary:v1 -->";
var CANARY_TITLE_PREFIX = "[dispatch-canary]";
var LIVE_URL_PROBE_MAX_ATTEMPTS = 5;
var LIVE_URL_PROBE_RETRY_DELAY_MS = 15e3;
var LEDGER_POLL_TIMEOUT_MS = 25 * 60 * 1e3;
var LEDGER_POLL_BACKOFF_START_MS = 2e3;
var LEDGER_POLL_BACKOFF_MAX_MS = 15e3;
var TERMINAL_REJECTED_STATES = /* @__PURE__ */ new Set([
  "dispatch-rejected",
  "superseded",
  "superseded-by-close"
]);
var STALE_CANARY_AGE_MS = 35 * 60 * 1e3;
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
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function probeLiveUrl(url, {
  fetchImpl = fetch,
  maxAttempts = LIVE_URL_PROBE_MAX_ATTEMPTS,
  retryDelayMs = LIVE_URL_PROBE_RETRY_DELAY_MS,
  sleepImpl = sleep
} = {}) {
  let lastReason = "never attempted";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.timeout(15e3)
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
    "Automated production canary for the dispatch broker (#307). Created, dispatched through the real dispatch broker and a dedicated no-op worker (`.github/workflows/agent-dispatch-canary.yml`), verified, and closed automatically. It never invokes a paid model, GCP credential, or self-hosted/privileged runner -- see docs/e2e-security-boundary.md.",
    "",
    `Source: ${source}`,
    `Orchestrator run: ${runUrl}`
  ];
  if (deployRunUrl) lines.push(`Deploy run: ${deployRunUrl}`);
  lines.push("", CANARY_MARKER);
  return lines.join("\n");
}
async function createCanaryIssue(api, repository, context) {
  const root = repositoryPath({ repository });
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const issue = await api.requestOk(`${root}/issues`, {
    method: "POST",
    body: {
      title: `[dispatch-canary] Production dispatch broker canary \u2014 ${timestamp}`,
      body: issueBody(context)
    }
  });
  if (!Number.isSafeInteger(issue?.number)) {
    throw new Error("GitHub did not return the created canary issue number");
  }
  return issue;
}
async function dispatchRouterCanary(api, repository, issueNumber) {
  await dispatchRouterEvent(
    api,
    { repository },
    { kind: "canary", issue: String(issueNumber) }
  );
}
var LEDGER_WORKFLOW_IDENTITY = "github-actions[bot]";
async function findCanaryGeneration(api, task) {
  const loaded = await loadLedger(api, task, LEDGER_WORKFLOW_IDENTITY, {
    createIfMissing: false
  });
  if (!loaded) return void 0;
  const generation = loaded.ledger.generations.find(
    (candidate) => candidate.pipeline === "canary"
  );
  return generation ? { ledger: loaded.ledger, generation } : void 0;
}
async function pollCanaryLedger(api, task, {
  timeoutMs = LEDGER_POLL_TIMEOUT_MS,
  sleepImpl = sleep,
  now = () => Date.now()
} = {}) {
  const deadline = now() + timeoutMs;
  let delay = LEDGER_POLL_BACKOFF_START_MS;
  while (now() < deadline) {
    const found = await findCanaryGeneration(api, task);
    if (found?.generation.state === "completed") {
      return found;
    }
    if (found && TERMINAL_REJECTED_STATES.has(found.generation.state)) {
      return { ...found, rejected: true };
    }
    await sleepImpl(delay);
    delay = Math.min(delay * 2, LEDGER_POLL_BACKOFF_MAX_MS);
  }
  throw new Error(
    "Timed out waiting for the canary dispatch ledger to reach a terminal state"
  );
}
async function closeCanaryIssue(api, task, { generation, runUrl, message }) {
  const root = repositoryPath(task);
  const body = message ?? `\u2705 Canary verified: dispatch broker generation g${generation.generation} completed successfully (worker run ${generation.attempt?.htmlUrl ?? "n/a"}). Closing automatically. Orchestrator run: ${runUrl}`;
  await api.requestOk(`${root}/issues/${task.issue}/comments`, {
    method: "POST",
    body: { body }
  });
  await api.requestOk(`${root}/issues/${task.issue}`, {
    method: "PATCH",
    body: { state: "closed", state_reason: "completed" }
  });
}
async function parkCanaryFailure(api, task, maintainer, reason) {
  const root = repositoryPath(task);
  try {
    await api.requestOk(`${root}/issues/${task.issue}/comments`, {
      method: "POST",
      body: {
        body: `\u{1F6A8} Canary failed: ${reason}

This issue is left open with evidence instead of being auto-closed. A maintainer must investigate.`
      }
    });
  } catch {
  }
  await ensureNeedsHumanParked(api, task, maintainer);
}
function hasNeedsHumanLabel(issue) {
  return (issue.labels ?? []).some(
    (label) => (typeof label === "string" ? label : label.name) === "status:needs-human"
  );
}
async function sweepOneStaleCanary(api, task, maintainer, alreadyParked) {
  const found = await findCanaryGeneration(api, task);
  const conclusion = found?.generation?.attempt?.conclusion;
  if (found?.generation.state === "completed" && conclusion === "success") {
    await closeCanaryIssue(api, task, {
      generation: found.generation,
      message: alreadyParked ? `\u{1F9F9} Swept by the scheduled canary janitor: this canary was previously parked status:needs-human after its orchestrator run never returned, but its dispatch broker ledger shows generation g${found.generation.generation} completed successfully since then. Recovering and closing.` : `\u{1F9F9} Swept by the scheduled canary janitor: this canary's own orchestrator run never returned (job timeout or workflow cancellation), but its dispatch broker ledger shows generation g${found.generation.generation} completed successfully. Closing.`
    });
    return {
      issue: task.issue,
      outcome: alreadyParked ? "closed-after-late-success" : "closed"
    };
  }
  if (alreadyParked) {
    return { issue: task.issue, outcome: "already-parked" };
  }
  await parkCanaryFailure(
    api,
    task,
    maintainer,
    "Swept by the scheduled canary janitor: this canary's own orchestrator run never returned (job timeout or workflow cancellation) and its dispatch broker ledger never reached a successful terminal state."
  );
  return { issue: task.issue, outcome: "parked" };
}
var CANARY_SWEEP_CONCURRENCY = 5;
async function sweepStaleCanaries(api, repository, repositoryId, maintainer, {
  now = () => Date.now(),
  ageMs = STALE_CANARY_AGE_MS
} = {}) {
  const root = repositoryPath({ repository });
  const openIssues = await listAll(
    api,
    `${root}/issues?state=open`
  );
  const stale = openIssues.filter((issue) => {
    if (issue.pull_request) return false;
    if (!issue.title?.startsWith(CANARY_TITLE_PREFIX)) return false;
    if (!issue.body?.includes(CANARY_MARKER)) return false;
    const ageMsActual = now() - Date.parse(issue.created_at);
    return Number.isFinite(ageMsActual) && ageMsActual >= ageMs;
  });
  const outcomes = await mapWithConcurrency(
    stale,
    CANARY_SWEEP_CONCURRENCY,
    (issue) => sweepOneStaleCanary(
      api,
      { repositoryId, repository, issue: issue.number },
      maintainer,
      hasNeedsHumanLabel(issue)
    )
  );
  return outcomes.map(
    (outcome, index) => outcome.status === "fulfilled" ? outcome.value : {
      issue: stale[index].number,
      outcome: "error",
      // Assumed Error-shaped, exactly as ../main.ts's own
      // dispatchReconcileScan assumes for the same mapWithConcurrency
      // rejection shape.
      error: outcome.reason.message
    }
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
  pollOptions = {}
}) {
  if (liveUrl) {
    const probe = await probeLiveUrl(liveUrl, probeOptions);
    if (!probe.ok) {
      const issue2 = await createCanaryIssue(api, repository, {
        source,
        runUrl,
        deployRunUrl
      });
      const task2 = { repositoryId, repository, issue: issue2.number };
      const reason = `Live URL probe failed for ${liveUrl}: ${probe.reason}`;
      await parkCanaryFailure(api, task2, maintainer, reason);
      throw new Error(`Post-deploy smoke: ${reason}`);
    }
  }
  const issue = await createCanaryIssue(api, repository, {
    source,
    runUrl,
    deployRunUrl
  });
  const task = { repositoryId, repository, issue: issue.number };
  try {
    await dispatchRouterCanary(api, repository, issue.number);
    const result = await pollCanaryLedger(api, task, pollOptions);
    const conclusion = result.generation?.attempt?.conclusion;
    if (result.rejected || conclusion !== "success") {
      throw new Error(
        `Canary dispatch generation g${result.generation?.generation} ended in state '${result.generation?.state}'` + (conclusion ? ` with conclusion '${conclusion}'` : "") + "."
      );
    }
    await closeCanaryIssue(api, task, {
      generation: result.generation,
      runUrl
    });
    return { issue: issue.number };
  } catch (error) {
    await parkCanaryFailure(api, task, maintainer, error.message);
    throw error;
  }
}
async function main() {
  const api = createGitHubApi({ token: env("GITHUB_TOKEN") });
  const repository = env("GITHUB_REPOSITORY");
  const repositoryId = Number(env("GITHUB_REPOSITORY_ID"));
  const maintainer = env("MAINTAINER_LOGIN");
  const source = env("CANARY_SOURCE");
  const runUrl = `${env("GITHUB_SERVER_URL")}/${repository}/actions/runs/${env("GITHUB_RUN_ID")}`;
  const deployRunUrl = env("DEPLOY_RUN_URL", false);
  const liveUrl = env("LIVE_URL", false);
  const sweepStale = env("SWEEP_STALE", false) === "true";
  let sweepError;
  if (sweepStale) {
    try {
      const swept = await sweepStaleCanaries(
        api,
        repository,
        repositoryId,
        maintainer
      );
      const sweepFailures = swept.filter((entry) => entry.outcome === "error");
      for (const entry of swept) {
        const marker = entry.outcome === "error" ? "::error::" : "::notice::";
        const detail = entry.error ? ` (${entry.error})` : "";
        console.log(
          `${marker}canary janitor: #${entry.issue} ${entry.outcome}${detail}`
        );
      }
      if (sweepFailures.length > 0) {
        sweepError = new Error(
          `Canary janitor sweep failed for ${sweepFailures.length} issue(s): ` + sweepFailures.map((entry) => `#${entry.issue}`).join(", ")
        );
      }
    } catch (error) {
      console.log(
        `::error::canary janitor sweep aborted: ${error.message}`
      );
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
    liveUrl
  });
  await output("issue", String(result.issue));
  if (sweepError) throw sweepError;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
export {
  CANARY_SWEEP_CONCURRENCY,
  STALE_CANARY_AGE_MS,
  closeCanaryIssue,
  createCanaryIssue,
  dispatchRouterCanary,
  issueBody,
  parkCanaryFailure,
  pollCanaryLedger,
  probeLiveUrl,
  runDispatchCanary,
  sweepStaleCanaries
};
