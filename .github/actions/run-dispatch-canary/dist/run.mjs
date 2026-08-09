// apps/dispatch-broker/src/canary/run.ts
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

// libs/dispatch-contracts/src/failure.ts
var OWNING_SYSTEMS = Object.freeze([
  "controller",
  "runner",
  "worker",
  "finalizer",
  "projector"
]);
var FAILURE_PHASES = [
  "signal",
  "authorization",
  "intent",
  "scheduling",
  "launch",
  "runner_allocation",
  "bootstrap",
  "provider_admission",
  "provider_execution",
  "agent_execution",
  "validation",
  "reporting",
  "telemetry",
  "reconciliation"
];
var PHASE_OWNERS = Object.freeze({
  signal: "controller",
  authorization: "controller",
  intent: "controller",
  scheduling: "controller",
  launch: "controller",
  runner_allocation: "runner",
  bootstrap: "worker",
  provider_admission: "worker",
  provider_execution: "worker",
  agent_execution: "worker",
  validation: "finalizer",
  reporting: "projector",
  telemetry: "projector",
  // Every system reconciles the state it owns, so this phase alone cannot
  // name its owner from the phase. `classifyFailure` requires an explicit
  // owningSystem when the phase is `reconciliation`; this default is the
  // most common case, not an assumption the classifier is allowed to make
  // silently.
  reconciliation: "controller"
});
var RETRY_DISPOSITIONS = [
  "never",
  "immediate",
  "backoff",
  "after_health_change",
  "after_configuration_change",
  "manual"
];
var FAILURE_REASONS = [
  // controller / signal + reconciliation
  "signal_lost",
  "signal_evicted",
  "signal_unverifiable",
  "quick_task_digest_mismatch",
  "concurrency_group_unverifiable",
  // controller / authorization + intent + scheduling + launch
  "unauthorized_actor",
  "ambiguous_pipeline_selection",
  "intent_superseded",
  "launch_response_lost",
  "launch_rejected",
  // runner
  "runner_allocation_timeout",
  "runner_lost",
  // worker / bootstrap
  "work_token_mint_failed",
  "checkout_failed",
  "tool_setup_failed",
  // worker / provider + agent
  "provider_admission_denied",
  "provider_graph_allocation_failed",
  "provider_unavailable",
  "agent_turn_budget_exhausted",
  "agent_exited_nonzero",
  // finalizer
  "deliverable_absent",
  "deliverable_lookup_failed",
  "deliverable_unattributable",
  // projector
  "github_write_failed",
  "telemetry_upload_failed",
  "telemetry_absent",
  // any system
  "internal_error"
];
var PHASES = new Set(FAILURE_PHASES);
var REASONS = new Set(FAILURE_REASONS);
var DISPOSITIONS = new Set(RETRY_DISPOSITIONS);
var SYSTEMS = new Set(OWNING_SYSTEMS);
function isWellFormedFailureClassification(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value;
  if (typeof candidate.owningSystem !== "string" || !SYSTEMS.has(candidate.owningSystem)) {
    return false;
  }
  if (typeof candidate.phase !== "string" || !PHASES.has(candidate.phase)) {
    return false;
  }
  if (typeof candidate.reason !== "string" || !REASONS.has(candidate.reason)) {
    return false;
  }
  if (typeof candidate.retryDisposition !== "string" || !DISPOSITIONS.has(candidate.retryDisposition)) {
    return false;
  }
  if (candidate.retryBudget !== void 0 && (!Number.isSafeInteger(candidate.retryBudget) || Number(candidate.retryBudget) < 0)) {
    return false;
  }
  if (candidate.evidence !== void 0 && typeof candidate.evidence !== "string") {
    return false;
  }
  if (candidate.detail !== void 0 && typeof candidate.detail !== "string") {
    return false;
  }
  return true;
}

// libs/dispatch-contracts/src/outcomes.ts
var DISPATCH_OUTCOME_KINDS = [
  "startup-failure",
  "trajectory-failure",
  "outcome-gate-failure",
  "park",
  "no-op",
  "pull-request",
  "merged-deliverable",
  "review",
  "comment",
  "closed",
  "unknown-success"
];
function isDispatchOutcomeKind(value) {
  return DISPATCH_OUTCOME_KINDS.includes(value);
}
function isDispatchOutcomeReference(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value;
  return candidate.kind === "pull-request" && Number.isSafeInteger(candidate.number) && Number(candidate.number) > 0;
}

// libs/dispatch-contracts/src/pipelines.ts
var PIPELINE_CONTRACTS = Object.freeze({
  claude: Object.freeze({
    pipeline: "claude",
    contract: "agent",
    workflowFile: "claude.yml",
    displayName: "Claude",
    runNameLabel: "Claude issue agent",
    label: "agent:claude",
    reviewLabel: "review:claude",
    replyTrigger: "@claude",
    replyTriggerAliases: Object.freeze([]),
    redispatchCommand: "@claude",
    botLogin: "claude[bot]"
  }),
  codex: Object.freeze({
    pipeline: "codex",
    contract: "agent",
    workflowFile: "codex.yml",
    displayName: "Codex",
    runNameLabel: "Codex issue agent",
    label: "agent:codex",
    reviewLabel: "review:codex",
    replyTrigger: "/codex",
    replyTriggerAliases: Object.freeze([]),
    redispatchCommand: "/codex",
    botLogin: "agent-lcars[bot]"
  }),
  opencode: Object.freeze({
    pipeline: "opencode",
    contract: "agent",
    workflowFile: "opencode.yml",
    displayName: "OpenCode",
    runNameLabel: "OpenCode issue agent",
    label: "agent:opencode",
    reviewLabel: "review:opencode",
    replyTrigger: "/oc",
    replyTriggerAliases: Object.freeze(["/opencode"]),
    redispatchCommand: "/opencode",
    botLogin: "agent-lcars[bot]"
  }),
  canary: Object.freeze({
    // #307's no-op production canary. It carries no label, no reply command,
    // and no bot login because nothing may ever select it from an issue: the
    // only way to produce a `canary` intent is normalize.mjs's dedicated
    // workflow_dispatch `kind: 'canary'` branch, fired exclusively by this
    // repo's own trusted dispatch-canary.yml/post-deploy-smoke.yml.
    pipeline: "canary",
    contract: "canary",
    workflowFile: "agent-dispatch-canary.yml",
    displayName: "Dispatch canary",
    runNameLabel: "Dispatch canary worker",
    replyTriggerAliases: Object.freeze([])
  })
});
var DISPATCH_PIPELINES = Object.freeze(
  Object.keys(PIPELINE_CONTRACTS)
);
var AGENT_PIPELINES = Object.freeze(
  DISPATCH_PIPELINES.filter(
    (pipeline) => PIPELINE_CONTRACTS[pipeline].contract === "agent"
  )
);
var WORKER_WORKFLOW_FILES = Object.freeze(
  new Set(
    DISPATCH_PIPELINES.map(
      (pipeline) => PIPELINE_CONTRACTS[pipeline].workflowFile
    )
  )
);
var AGENT_LABELS = new Map(
  AGENT_PIPELINES.map((pipeline) => [
    PIPELINE_CONTRACTS[pipeline].label,
    pipeline
  ])
);
var REVIEW_LABELS = new Map(
  AGENT_PIPELINES.map((pipeline) => [
    PIPELINE_CONTRACTS[pipeline].reviewLabel,
    pipeline
  ])
);
var DISPATCH_LABELS = Object.freeze([
  ...AGENT_LABELS.keys(),
  ...REVIEW_LABELS.keys()
]);
var REPLY_COMMANDS = new Map(
  AGENT_PIPELINES.flatMap((pipeline) => {
    const contract = PIPELINE_CONTRACTS[pipeline];
    return [
      contract.replyTrigger,
      ...contract.replyTriggerAliases
    ].map((command) => [command, pipeline]);
  })
);
var AGENT_BOT_LOGINS = Object.freeze([
  ...new Set(
    AGENT_PIPELINES.map(
      (pipeline) => PIPELINE_CONTRACTS[pipeline].botLogin
    )
  )
]);
function isDispatchPipeline(pipeline) {
  return Object.hasOwn(PIPELINE_CONTRACTS, pipeline);
}

// libs/dispatch-contracts/src/projection.ts
var PROJECTION_CONVERGENCE_STATES = [
  /** No convergence attempt has been recorded yet. */
  "pending",
  /** `observedRevision === desiredRevision`: the last attempt's GitHub
   *  writes all succeeded. */
  "converged",
  /** The last convergence attempt failed; `observedRevision` still reflects
   *  the most recent revision that DID succeed (0 if there has never been
   *  one), not the failed attempt's target. */
  "diverged"
];
var CONVERGENCE_STATES = new Set(
  PROJECTION_CONVERGENCE_STATES
);
function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function isWellFormedProjectionStatus(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value;
  if (!isNonNegativeInteger(candidate.desiredRevision)) return false;
  if (!isNonNegativeInteger(candidate.observedRevision)) return false;
  if (typeof candidate.state !== "string" || !CONVERGENCE_STATES.has(candidate.state)) {
    return false;
  }
  if (typeof candidate.observedAt !== "string" || candidate.observedAt.length === 0) {
    return false;
  }
  return true;
}

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
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}
var GENERATION_STATES = new Set(
  LEDGER_GENERATION_STATES
);
function isWellFormedGeneration(value) {
  if (!isPlainObject(value)) return false;
  if (!isPositiveInteger(value.generation)) return false;
  if (!isNonEmptyString(value.intentId)) return false;
  if (!isNonEmptyString(value.sourceId)) return false;
  if (!isNonEmptyString(value.occurredAt)) return false;
  if (typeof value.pipeline !== "string" || !isDispatchPipeline(value.pipeline)) {
    return false;
  }
  if (typeof value.state !== "string" || !GENERATION_STATES.has(value.state)) {
    return false;
  }
  if (value.attempt !== void 0 && !isPlainObject(value.attempt)) {
    return false;
  }
  if (isPlainObject(value.attempt)) {
    if (value.attempt.outcome !== void 0 && !isDispatchOutcomeKind(value.attempt.outcome)) {
      return false;
    }
    if (value.attempt.outcomeReference !== void 0 && !isDispatchOutcomeReference(value.attempt.outcomeReference)) {
      return false;
    }
    if (value.attempt.outcomeReference !== void 0 && value.attempt.outcome !== "pull-request") {
      return false;
    }
  }
  return true;
}
function isWellFormedSource(value) {
  if (!isPlainObject(value)) return false;
  return isNonEmptyString(value.sourceKind) && isNonEmptyString(value.sourceId);
}
function isWellFormedAnomaly(value) {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.kind) || !isNonEmptyString(value.occurredAt)) {
    return false;
  }
  if (value.failure !== void 0 && !isWellFormedFailureClassification(value.failure)) {
    return false;
  }
  return true;
}
function isWellFormedLedger(value) {
  if (!isPlainObject(value)) return false;
  if (value.schema !== LEDGER_SCHEMA) return false;
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
    return false;
  }
  if (!isPlainObject(value.task)) return false;
  if (!isNonEmptyString(value.task.repository)) return false;
  if (!isPositiveInteger(value.task.issue)) return false;
  if (!isPositiveInteger(value.task.repositoryId)) return false;
  if (!Array.isArray(value.sources) || !Array.isArray(value.generations)) {
    return false;
  }
  if (!Array.isArray(value.anomalies)) return false;
  if (!isPlainObject(value.control)) return false;
  if (!value.generations.every(isWellFormedGeneration)) return false;
  if (!value.sources.every(isWellFormedSource)) return false;
  if (!value.anomalies.every(isWellFormedAnomaly)) return false;
  if (value.projection !== void 0 && !isWellFormedProjectionStatus(value.projection)) {
    return false;
  }
  return true;
}

// libs/dispatch-contracts/src/marker.ts
function formatAttemptId({ generation, intentId }) {
  return `g${generation}:${intentId}`;
}

// libs/dispatch-contracts/src/oidc.ts
var HOSTED_COMPLETION_PATH = "/api/control-plane/completion";
var HOSTED_COMPLETION_URL = `https://agent-console.supersprinkles.racing${HOSTED_COMPLETION_PATH}`;
var HOSTED_TASK_STATE_PATH = "/api/control-plane/task-state";
var HOSTED_TASK_STATE_URL = `https://agent-console.supersprinkles.racing${HOSTED_TASK_STATE_PATH}`;
var WEBHOOK_INGRESS_PROBE_PATH = "/api/control-plane/webhook/probe";
var WEBHOOK_INGRESS_PROBE_URL = `https://agent-console.supersprinkles.racing${WEBHOOK_INGRESS_PROBE_PATH}`;

// libs/dispatch-contracts/src/task-state.ts
var AUTHORITATIVE_TASK_STATE_SCHEMA = "agent-lcars.authoritative-task-state/v1";
function isAuthoritativeTaskState(value) {
  if (!isPlainObject(value)) return false;
  const task = value.task;
  const controllerState = value.controllerState;
  if (!isPlainObject(task) || !isPlainObject(controllerState)) return false;
  const generations = controllerState.generations;
  if (!Array.isArray(generations)) return false;
  const validationLedger = {
    ...controllerState,
    generations: generations.map(
      (generation) => isPlainObject(generation) && isPlainObject(generation.attempt) ? {
        ...generation,
        attempt: { ...generation.attempt, token: "redacted-for-read" }
      } : generation
    )
  };
  return value.schema === AUTHORITATIVE_TASK_STATE_SCHEMA && Number.isSafeInteger(value.storageRevision) && value.storageRevision >= 0 && typeof value.updatedAt === "string" && isWellFormedLedger(validationLedger) && task.repositoryId === validationLedger.task.repositoryId && task.repository === validationLedger.task.repository && task.issue === validationLedger.task.issue;
}

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
var CANARY_MARKER = "<!-- agent-lcars:dispatch-canary-canonical:v2 -->";
var LEGACY_CANARY_MARKER = "<!-- agent-lcars:dispatch-canary:v1 -->";
var CANARY_TITLE_PREFIX = "[dispatch-canary]";
var CANARY_TITLE = "[dispatch-canary] Production dispatch broker canary";
var LIVE_URL_PROBE_MAX_ATTEMPTS = 5;
var LIVE_URL_PROBE_RETRY_DELAY_MS = 15e3;
var LEDGER_POLL_TIMEOUT_MS = 10 * 60 * 1e3;
var LEDGER_POLL_BACKOFF_START_MS = 2e3;
var LEDGER_POLL_BACKOFF_MAX_MS = 15e3;
var TERMINAL_REJECTED_STATES = /* @__PURE__ */ new Set([
  "dispatch-rejected",
  "superseded",
  "superseded-by-close"
]);
var STALE_CANARY_AGE_MS = 15 * 60 * 1e3;
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
    "Canonical automated production canary for the dispatch broker (#307, #677). Every run reuses this issue, dispatches it through the real broker and a dedicated no-op worker (`.github/workflows/agent-dispatch-canary.yml`), then closes it on success or leaves it open as a release blocker on failure. It never invokes a paid model, GCP credential, or self-hosted/privileged runner -- see docs/e2e-security-boundary.md.",
    "",
    `Source: ${source}`,
    `Orchestrator run: ${runUrl}`
  ];
  if (deployRunUrl) lines.push(`Deploy run: ${deployRunUrl}`);
  lines.push("", CANARY_MARKER);
  return lines.join("\n");
}
async function prepareCanaryIssue(api, repository, context) {
  const root = repositoryPath({ repository });
  const issues = await listAll(
    api,
    `${root}/issues?state=all`
  );
  const canonical = issues.filter(
    (issue2) => !issue2.pull_request && issue2.title?.startsWith(CANARY_TITLE_PREFIX) && issue2.body?.includes(CANARY_MARKER)
  );
  if (canonical.length > 1) {
    throw new Error(
      `Duplicate canonical dispatch canary issues: ${canonical.map((issue2) => `#${issue2.number}`).join(", ")}`
    );
  }
  const body = issueBody(context);
  if (canonical.length === 1) {
    const existing = canonical[0];
    await api.requestOk(`${root}/issues/${existing.number}`, {
      method: "PATCH",
      // Reopening before the probe makes a killed orchestrator visible to
      // the stale-canary janitor. The broker deliberately allows only its
      // no-op canary pipeline to dispatch against the ledger's possibly
      // still-closed control projection; ordinary work remains fail-closed.
      body: { title: CANARY_TITLE, body, state: "open" }
    });
    return { number: existing.number };
  }
  const issue = await api.requestOk(`${root}/issues`, {
    method: "POST",
    body: {
      title: CANARY_TITLE,
      body
    }
  });
  if (!Number.isSafeInteger(issue?.number)) {
    throw new Error("GitHub did not return the canonical canary issue number");
  }
  return issue;
}
async function dispatchRouterCanary(api, repository, issueNumber, callerId) {
  return dispatchRouterEvent(
    api,
    { repository },
    {
      kind: "canary",
      issue: String(issueNumber),
      caller_id: callerId
    }
  );
}
var LEDGER_WORKFLOW_IDENTITY = "github-actions[bot]";
function assertCanaryContracts({ ledger, generation }) {
  const expectedAttemptId = formatAttemptId(generation);
  if (generation.attempt?.attemptId !== expectedAttemptId) {
    throw new Error(
      `Canary controller contract failed: expected attemptId '${expectedAttemptId}', got '${generation.attempt?.attemptId ?? "missing"}'.`
    );
  }
  if (generation.attempt.outcome !== "comment") {
    throw new Error(
      `Canary finalizer contract failed: expected exact comment outcome, got '${generation.attempt.outcome ?? "missing"}'.`
    );
  }
  const projection = ledger.projection;
  if (projection?.state !== "converged" || projection.desiredRevision !== projection.observedRevision || projection.desiredRevision !== ledger.revision - 1) {
    throw new Error(
      `Canary projector contract failed: expected a converged checkpoint for the terminal ledger revision immediately before the checkpoint write, got ${projection ? JSON.stringify(projection) : "no projection status"}.`
    );
  }
}
function isCanaryContractObservationPending({
  ledger,
  generation
}) {
  const attempt = generation.attempt;
  if (attempt?.attemptId !== formatAttemptId(generation)) return false;
  if (attempt.outcome !== void 0 && attempt.outcome !== "comment") {
    return false;
  }
  const projection = ledger.projection;
  if (projection?.state === "diverged" && projection.desiredRevision === ledger.revision - 1) {
    return false;
  }
  if (projection?.state === "converged" && projection.desiredRevision === ledger.revision - 1 && projection.observedRevision !== projection.desiredRevision) {
    return false;
  }
  if (attempt.outcome === void 0) return true;
  if (!projection || projection.state === "pending") return true;
  return (projection.state === "converged" || projection.state === "diverged") && projection.desiredRevision !== ledger.revision - 1;
}
async function findCanaryGeneration(task, sourceId, fetchImpl = fetch, baseUrl = HOSTED_TASK_STATE_URL) {
  const [owner, repo] = task.repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository ${task.repository}`);
  const url = new URL(
    `${baseUrl}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${task.issue}`
  );
  url.searchParams.set("repositoryId", String(task.repositoryId));
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15e3)
  });
  if (response.status === 404) return void 0;
  if (!response.ok) {
    throw new Error(
      `Authoritative task-state read failed with HTTP ${response.status}`
    );
  }
  const state = await response.json();
  if (!isAuthoritativeTaskState(state)) {
    throw new Error("Authoritative task-state response was malformed");
  }
  if (state.task.repositoryId !== task.repositoryId || state.task.repository !== task.repository || state.task.issue !== task.issue) {
    throw new Error(
      "Authoritative task-state response did not match the requested task"
    );
  }
  const generation = state.controllerState.generations.filter(
    (candidate) => candidate.pipeline === "canary" && (sourceId === void 0 || candidate.sourceId === sourceId)
  ).sort((left, right) => right.generation - left.generation)[0];
  return generation ? {
    ledger: state.controllerState,
    generation,
    storageRevision: state.storageRevision,
    authoritativeUpdatedAt: state.updatedAt
  } : void 0;
}
function describeCanaryObservation(found) {
  if (!found) return "awaiting a ledger generation for this caller";
  const { generation, ledger } = found;
  const attempt = generation.attempt;
  const projection = ledger.projection;
  return [
    `g${generation.generation}`,
    `state=${generation.state}`,
    `worker=${attempt?.htmlUrl ?? "unbound"}`,
    `status=${attempt?.status ?? "unknown"}`,
    `conclusion=${attempt?.conclusion ?? "unknown"}`,
    `outcome=${attempt?.outcome ?? "missing"}`,
    projection ? `projection=${projection.state}:${projection.observedRevision}/${projection.desiredRevision}@r${ledger.revision}` : "projection=missing",
    `storage=r${found.storageRevision ?? "unknown"}@${found.authoritativeUpdatedAt ?? "unknown"}`
  ].join(" ");
}
function elapsedSeconds(startedAt, observedAt) {
  return Math.max(0, Math.round((observedAt - startedAt) / 1e3));
}
async function pollCanaryLedger(api, task, {
  timeoutMs = LEDGER_POLL_TIMEOUT_MS,
  sleepImpl = sleep,
  now = () => Date.now(),
  sourceId,
  log = console.log,
  fetchImpl,
  taskStateUrl
} = {}) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let delay = LEDGER_POLL_BACKOFF_START_MS;
  let lastObservation;
  while (now() < deadline) {
    const found = await findCanaryGeneration(
      task,
      sourceId,
      fetchImpl ?? api.taskStateFetch,
      taskStateUrl
    );
    const observation = describeCanaryObservation(found);
    if (observation !== lastObservation) {
      log(
        `::notice::canary ledger after ${elapsedSeconds(startedAt, now())}s: ${observation}`
      );
      lastObservation = observation;
    }
    if (found?.generation.state === "completed") {
      if (found.generation.attempt?.conclusion !== "success") return found;
      if (!isCanaryContractObservationPending(found)) {
        try {
          assertCanaryContracts(found);
        } catch (error) {
          throw new Error(
            `${error.message} Authoritative observation: ${describeCanaryObservation(found)} source=${found.generation.sourceId}.`,
            { cause: error }
          );
        }
        return found;
      }
    }
    if (found && TERMINAL_REJECTED_STATES.has(found.generation.state)) {
      return { ...found, rejected: true };
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleepImpl(Math.min(delay, remaining));
    delay = Math.min(delay * 2, LEDGER_POLL_BACKOFF_MAX_MS);
  }
  throw new Error(
    `Timed out waiting for the canary dispatch ledger to reach a verified terminal contract after ${elapsedSeconds(startedAt, now())}s; last observation: ${lastObservation ?? "poll ended before the first observation"}`
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
  const unlabel = await api.request(
    `${root}/issues/${task.issue}/labels/${encodeURIComponent(
      "status:needs-human"
    )}`,
    { method: "DELETE" }
  );
  if (unlabel.status !== 200 && unlabel.status !== 404) {
    throw new Error(
      `Could not clear status:needs-human from canonical canary issue: HTTP ${unlabel.status}`
    );
  }
}
async function parkCanaryFailure(api, task, maintainer, reason) {
  const root = repositoryPath(task);
  await api.requestOk(`${root}/issues/${task.issue}`, {
    method: "PATCH",
    body: { state: "open" }
  });
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
async function ledgerCommentDiagnostic(api, task) {
  try {
    const loaded = await loadLedger(api, task, LEDGER_WORKFLOW_IDENTITY, {
      createIfMissing: false
    });
    if (!loaded) return "GitHub ledger diagnostic: comment absent.";
    return `GitHub ledger diagnostic only: comment ${loaded.comment.id}, revision ${loaded.ledger.revision}.`;
  } catch (error) {
    return `GitHub ledger diagnostic unavailable: ${error.message}`;
  }
}
function hasNeedsHumanLabel(issue) {
  return (issue.labels ?? []).some(
    (label) => (typeof label === "string" ? label : label.name) === "status:needs-human"
  );
}
async function sweepOneStaleCanary(api, task, maintainer, alreadyParked) {
  const found = await findCanaryGeneration(
    task,
    void 0,
    api.taskStateFetch
  );
  const conclusion = found?.generation?.attempt?.conclusion;
  if (found?.generation.state === "completed" && conclusion === "success") {
    assertCanaryContracts(found);
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
    const canonical = issue.body?.includes(CANARY_MARKER);
    const legacy = issue.body?.includes(LEGACY_CANARY_MARKER);
    if (!canonical && !legacy) return false;
    const activityAt = canonical ? issue.updated_at ?? issue.created_at : issue.created_at;
    const ageMsActual = now() - Date.parse(activityAt);
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
  pollOptions = {},
  callerId = randomUUID()
}) {
  if (liveUrl) {
    const probe = await probeLiveUrl(liveUrl, probeOptions);
    if (!probe.ok) {
      const issue2 = await prepareCanaryIssue(api, repository, {
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
  const issue = await prepareCanaryIssue(api, repository, {
    source,
    runUrl,
    deployRunUrl
  });
  const task = { repositoryId, repository, issue: issue.number };
  try {
    const routerRun = await dispatchRouterCanary(
      api,
      repository,
      issue.number,
      callerId
    );
    console.log(`::notice::canary router dispatched: ${routerRun.htmlUrl}`);
    const result = await pollCanaryLedger(api, task, {
      ...pollOptions,
      sourceId: callerId
    });
    const conclusion = result.generation?.attempt?.conclusion;
    if (result.rejected || conclusion !== "success") {
      throw new Error(
        `Canary dispatch generation g${result.generation?.generation} ended in state '${result.generation?.state}'` + (conclusion ? ` with conclusion '${conclusion}'` : "") + "."
      );
    }
    assertCanaryContracts(result);
    await closeCanaryIssue(api, task, {
      generation: result.generation,
      runUrl
    });
    return { issue: issue.number };
  } catch (error) {
    const diagnostic = await ledgerCommentDiagnostic(api, task);
    await parkCanaryFailure(
      api,
      task,
      maintainer,
      `${error.message} ${diagnostic}`
    );
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
  LEDGER_POLL_TIMEOUT_MS,
  STALE_CANARY_AGE_MS,
  assertCanaryContracts,
  closeCanaryIssue,
  dispatchRouterCanary,
  issueBody,
  parkCanaryFailure,
  pollCanaryLedger,
  prepareCanaryIssue,
  probeLiveUrl,
  runDispatchCanary,
  sweepStaleCanaries
};
