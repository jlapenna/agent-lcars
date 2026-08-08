// apps/dispatch-broker/src/main.ts
import crypto3 from "node:crypto";
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
function classifyFailure({
  phase,
  reason,
  retryDisposition,
  owningSystem,
  retryBudget,
  evidence,
  detail
}) {
  if (!PHASES.has(phase)) {
    throw new Error(`Unknown failure phase: ${phase}`);
  }
  if (!REASONS.has(reason)) {
    throw new Error(`Unknown failure reason code: ${reason}`);
  }
  if (!DISPOSITIONS.has(retryDisposition)) {
    throw new Error(`Unknown retry disposition: ${retryDisposition}`);
  }
  if (owningSystem !== void 0 && !SYSTEMS.has(owningSystem)) {
    throw new Error(`Unknown owning system: ${owningSystem}`);
  }
  if (phase === "reconciliation" && owningSystem === void 0) {
    throw new Error(
      "Reconciliation failures must name their owning system: every system reconciles the state it owns"
    );
  }
  if (retryBudget !== void 0 && (!Number.isSafeInteger(retryBudget) || retryBudget < 0)) {
    throw new Error(`Invalid retry budget: ${retryBudget}`);
  }
  return {
    owningSystem: owningSystem ?? PHASE_OWNERS[phase],
    phase,
    reason,
    retryDisposition,
    ...retryBudget === void 0 ? {} : { retryBudget },
    ...evidence === void 0 ? {} : { evidence },
    ...detail === void 0 ? {} : { detail }
  };
}
function needsMaintainer(failure) {
  return failure.retryDisposition === "manual" || failure.retryDisposition === "after_configuration_change" || failure.retryDisposition === "never" && failure.reason !== "intent_superseded";
}
function formatFailure(failure) {
  const budget = failure.retryBudget === void 0 ? "" : ` budget=${failure.retryBudget}`;
  return `[${failure.owningSystem}/${failure.phase}] ${failure.reason} retry=${failure.retryDisposition}${budget}`;
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
var GENERIC_REPLY_COMMAND = "@agent";
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
function pipelineContract(pipeline) {
  const contract = PIPELINE_CONTRACTS[pipeline];
  if (!contract) throw new Error(`Unsupported worker pipeline: ${pipeline}`);
  return contract;
}
function workerWorkflow(pipeline) {
  return pipelineContract(pipeline).workflowFile;
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
var GENERATION_STATES = new Set(
  LEDGER_GENERATION_STATES
);

// libs/dispatch-contracts/src/marker.ts
function formatAttemptId({ generation, intentId }) {
  return `g${generation}:${intentId}`;
}
function formatDispatchMarker(attempt) {
  return `[dispatch:${formatAttemptId(attempt)}]`;
}
function displayTitleMatchesAttempt(displayTitle, attempt) {
  return Boolean(displayTitle?.includes(formatDispatchMarker(attempt)));
}
var ROUTER_GROUP_MARKER_RE = /\[router-group:(\d+):(\d+)\]/u;
function parseRouterGroupMarker(displayTitle) {
  const match = displayTitle?.match(ROUTER_GROUP_MARKER_RE);
  return match ? { repositoryId: Number(match[1]), issue: Number(match[2]) } : void 0;
}

// libs/dispatch-contracts/src/oidc.ts
var COMPLETION_OIDC_AUDIENCE = "agent-lcars-dispatch-completion";
var HOSTED_COMPLETION_PATH = "/api/control-plane/completion";
var HOSTED_COMPLETION_URL = `https://agent-console.supersprinkles.racing${HOSTED_COMPLETION_PATH}`;
var WEBHOOK_INGRESS_PROBE_PATH = "/api/control-plane/webhook/probe";
var WEBHOOK_INGRESS_PROBE_URL = `https://agent-console.supersprinkles.racing${WEBHOOK_INGRESS_PROBE_PATH}`;

// libs/dispatch-contracts/src/quick-task.ts
function serializeIdentity({
  repository,
  pipeline,
  title,
  description
}) {
  return JSON.stringify({ repository, pipeline, title, description });
}
function quickTaskDigest(identity, sha256Hex2) {
  return sha256Hex2(serializeIdentity(identity));
}
var QUICK_TASK_MARKER_SOURCE = "<!-- agent-lcars:quick-task-request:v1 id=([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) digest=([0-9a-f]{64}) -->";
var QUICK_TASK_MARKER_RE = new RegExp(QUICK_TASK_MARKER_SOURCE, "u");
function quickTaskMarkerMatcher() {
  return new RegExp(QUICK_TASK_MARKER_SOURCE, "gu");
}

// libs/dispatch-contracts/src/readiness.ts
var LANE_READINESS_FAILURES = [
  "credential",
  "provider",
  "bootstrap"
];
function isLaneReadinessFailure(value) {
  return typeof value === "string" && LANE_READINESS_FAILURES.includes(value);
}

// libs/dispatch-contracts/src/webhook-ingress.ts
var WEBHOOK_INGRESS_CANARY_MARKER = "<!-- agent-lcars:webhook-ingress-canary:v1 -->";
var WEBHOOK_INGRESS_CANARY_TITLE = "GitHub App webhook ingress canary sentinel";

// libs/dispatch-reconcile/src/scan.ts
var CLOSED_SWEEP_WINDOW_MS = 24 * 60 * 60 * 1e3;
var RECONCILE_DISPATCH_CONCURRENCY = 5;
async function listAllIssues(transport, query) {
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const items = await transport.listIssues({
      ...query,
      page,
      perPage: 100
    });
    if (!Array.isArray(items)) {
      throw new Error("GitHub issue listing response is not an array");
    }
    all.push(...items);
    if (items.length < 100) return all;
  }
  throw new Error("GitHub issue pagination exceeded safety bound");
}
function dedupeIssues(lanes) {
  const byNumber = /* @__PURE__ */ new Map();
  for (const issue of lanes.flat()) {
    if (Number.isSafeInteger(issue?.number)) byNumber.set(issue.number, issue);
  }
  return [...byNumber.values()].sort(
    (left, right) => left.number - right.number
  );
}
async function listLabeledIssues(transport, repository, state, since) {
  const lanes = await Promise.all(
    DISPATCH_LABELS.map(
      (label) => listAllIssues(transport, {
        repository,
        state,
        label,
        ...since && { since }
      })
    )
  );
  return dedupeIssues(lanes);
}
async function listAssignedIssues(transport, repository, state, assignee, since) {
  if (!assignee) return [];
  return listAllIssues(transport, {
    repository,
    state,
    assignee,
    ...since && { since }
  });
}
function listOpenAgentLabeledIssues(transport, repository) {
  return listLabeledIssues(transport, repository, "open");
}
function listOpenIssuesAssignedTo(transport, repository, fleetLogin) {
  return listAssignedIssues(transport, repository, "open", fleetLogin);
}
function listRecentlyClosedAgentLabeledIssues(transport, repository, now = /* @__PURE__ */ new Date()) {
  const since = new Date(
    new Date(now).getTime() - CLOSED_SWEEP_WINDOW_MS
  ).toISOString();
  return listLabeledIssues(transport, repository, "closed", since);
}
function listRecentlyClosedIssuesAssignedTo(transport, repository, fleetLogin, now = /* @__PURE__ */ new Date()) {
  const since = new Date(
    new Date(now).getTime() - CLOSED_SWEEP_WINDOW_MS
  ).toISOString();
  return listAssignedIssues(transport, repository, "closed", fleetLogin, since);
}
async function discoverReconcileCandidates(transport, repository, fleetLogin) {
  return dedupeIssues(
    await Promise.all([
      listOpenAgentLabeledIssues(transport, repository),
      listOpenIssuesAssignedTo(transport, repository, fleetLogin)
    ])
  );
}
async function discoverRecentlyClosedReconcileCandidates(transport, repository, fleetLogin, now = /* @__PURE__ */ new Date()) {
  return dedupeIssues(
    await Promise.all([
      listRecentlyClosedAgentLabeledIssues(transport, repository, now),
      listRecentlyClosedIssuesAssignedTo(
        transport,
        repository,
        fleetLogin,
        now
      )
    ])
  );
}
async function mapWithConcurrency(items, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runNext() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        await worker(items[index]);
        results[index] = { status: "fulfilled" };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(RECONCILE_DISPATCH_CONCURRENCY, items.length) },
      () => runNext()
    )
  );
  return results;
}
function errorMessage(reason) {
  return reason instanceof Error ? reason.message : String(reason);
}
async function dispatchReconcileScan(transport, repository, issueNumbers) {
  const outcomes = await mapWithConcurrency(
    issueNumbers,
    (issue) => transport.dispatchReconcile(repository, issue)
  );
  const result = {
    dispatched: 0,
    failed: []
  };
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      result.dispatched += 1;
    } else {
      result.failed.push({
        issue: issueNumbers[index],
        message: errorMessage(outcome.reason)
      });
    }
  });
  return result;
}
async function runReconcileScan(transport, repository, fleetLogin, now = /* @__PURE__ */ new Date()) {
  const [open, closed] = await Promise.all([
    discoverReconcileCandidates(transport, repository, fleetLogin),
    discoverRecentlyClosedReconcileCandidates(
      transport,
      repository,
      fleetLogin,
      now
    )
  ]);
  const issueNumbers = dedupeIssues([open, closed]).map(
    (issue) => issue.number
  );
  const dispatched = await dispatchReconcileScan(
    transport,
    repository,
    issueNumbers
  );
  return {
    candidates: issueNumbers.length,
    ...dispatched,
    openCandidates: open.length,
    closedCandidates: closed.length
  };
}

// apps/dispatch-broker/src/broker.ts
import crypto from "node:crypto";

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
function mutate(ledger, now, callback) {
  callback();
  ledger.revision += 1;
  ledger.updatedAt = now;
  validateLedger(ledger, ledger.task);
  return ledger;
}

// apps/dispatch-broker/src/modules/intent.ts
function compareIntentOrder(left, right) {
  const byTime = left.occurredAt.localeCompare(right.occurredAt);
  return byTime || left.sourceId.localeCompare(right.sourceId);
}
function sourceEvidence(intent) {
  return {
    intentId: intent.intentId,
    sourceKind: intent.sourceKind,
    sourceId: intent.sourceId,
    transportRunId: intent.transportRunId,
    occurredAt: intent.occurredAt,
    digest: intent.digest,
    authorization: intent.authorization
  };
}
function validateIntent(intent, task) {
  assertTaskRef(intent?.task);
  assertTaskRef(task);
  if (intent.task.repositoryId !== task.repositoryId || intent.task.repository.toLowerCase() !== task.repository.toLowerCase() || intent.task.issue !== task.issue) {
    throw new Error("Intent TaskRef mismatch");
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(intent.intentId ?? "")) {
    throw new Error("Invalid intent ID");
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(intent.sourceId ?? "")) {
    throw new Error("Invalid source ID");
  }
  if (!Number.isSafeInteger(intent.transportRunId) || intent.transportRunId <= 0) {
    throw new Error("Invalid transport run ID");
  }
  if (Number.isNaN(Date.parse(intent.occurredAt))) {
    throw new Error("Invalid intent occurrence time");
  }
  if (!isDispatchPipeline(intent.pipeline))
    throw new Error("Unsupported pipeline");
  if (!intent.authorization?.authorized) throw new Error("Unauthorized intent");
}
function generationForIntent(ledger, intentId) {
  return ledger.generations.find(
    (generation) => generation.intentId === intentId
  );
}
function acceptIntent(ledger, intent, now = (/* @__PURE__ */ new Date()).toISOString()) {
  validateLedger(ledger, intent.task);
  validateIntent(intent, ledger.task);
  const sourceDuplicate = ledger.sources.some(
    (source) => source.sourceKind === intent.sourceKind && source.sourceId === intent.sourceId
  );
  const transportDuplicate = ledger.sources.some(
    (source) => source.transportRunId === intent.transportRunId
  );
  if (sourceDuplicate || transportDuplicate) {
    return { outcome: "duplicate", ledger };
  }
  const existing = generationForIntent(ledger, intent.intentId);
  if (existing) {
    if (existing.digest !== intent.digest) {
      throw new Error("Semantic intent ID was reused with a different digest");
    }
    mutate(ledger, now, () => ledger.sources.push(sourceEvidence(intent)));
    return {
      outcome: "semantic-duplicate",
      generation: existing.generation,
      ledger
    };
  }
  const generation = {
    generation: ledger.generations.length + 1,
    intentId: intent.intentId,
    sourceId: intent.sourceId,
    occurredAt: intent.occurredAt,
    pipeline: intent.pipeline,
    mode: intent.mode,
    runbook: intent.runbook,
    context: intent.context,
    reply: intent.reply,
    digest: intent.digest,
    state: "accepted"
  };
  let outcome = "dispatch";
  mutate(ledger, now, () => {
    ledger.sources.push(sourceEvidence(intent));
    ledger.generations.push(generation);
    if (intent.dispatchable === false) {
      generation.state = "superseded";
      outcome = "stale-control-state";
      return;
    }
    if (ledger.control.closed && intent.pipeline !== "canary") {
      generation.state = "superseded-by-close";
      outcome = "closed";
      return;
    }
    const active = ledger.generations.find(
      (candidate) => candidate !== generation && ACTIVE_STATES.has(candidate.state)
    );
    const pending = ledger.generations.find(
      (candidate) => candidate !== generation && candidate.state === "pending"
    );
    const newestDesired = pending ?? active;
    if (newestDesired && compareIntentOrder(intent, newestDesired) <= 0) {
      generation.state = "superseded";
      outcome = "stale";
      return;
    }
    if (active) {
      if (pending) pending.state = "superseded";
      generation.state = "pending";
      outcome = "pending";
      return;
    }
    if (pending) pending.state = "superseded";
    generation.state = "accepted";
  });
  return { outcome, generation: generation.generation, ledger };
}

// apps/dispatch-broker/src/modules/scheduler.ts
var TERMINAL_RUN_STATUSES = /* @__PURE__ */ new Set(["completed"]);
function recordOutcome(ledger, generationNumber, outcome, outcomeReference, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const generation = findGeneration(ledger, generationNumber);
  if (!generation || ![
    "active",
    "completion-observed",
    "completion-awaiting-terminal",
    "completed"
  ].includes(generation.state)) {
    throw new Error("Generation is not awaiting a worker outcome");
  }
  const attempt = attemptOf(generation);
  if (attempt.outcome && attempt.outcome !== outcome) {
    throw new Error(
      `Generation ${generationNumber} already reported outcome ${attempt.outcome}, not ${outcome}`
    );
  }
  if (outcomeReference && attempt.outcomeReference && JSON.stringify(attempt.outcomeReference) !== JSON.stringify(outcomeReference)) {
    throw new Error(
      `Generation ${generationNumber} already reported a different outcome reference`
    );
  }
  if (attempt.outcome === outcome && (!outcomeReference || attempt.outcomeReference)) {
    return ledger;
  }
  return mutate(ledger, now, () => {
    attempt.outcome = outcome;
    if (outcomeReference) attempt.outcomeReference = outcomeReference;
  });
}
function findGeneration(ledger, generationNumber) {
  return ledger.generations.find(
    (candidate) => candidate.generation === generationNumber
  );
}
function attemptOf(generation) {
  const { attempt } = generation;
  if (!attempt) {
    throw new Error(`Generation ${generation.generation} has no attempt`);
  }
  return attempt;
}
function canDispatchOnAnchor(ledger, generation) {
  return !ledger.control.closed || generation.pipeline === "canary";
}
function beginDispatch(ledger, generationNumber, token, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const generation = findGeneration(ledger, generationNumber);
  if (!generation || !["accepted", "pending"].includes(generation.state)) {
    throw new Error("Generation is not dispatchable");
  }
  if (!canDispatchOnAnchor(ledger, generation)) {
    throw new Error("Closed anchor cannot dispatch");
  }
  if (ledger.generations.some((candidate) => ACTIVE_STATES.has(candidate.state))) {
    throw new Error("Another generation is active");
  }
  if (!/^[A-Za-z0-9_-]{16,200}$/u.test(token))
    throw new Error("Invalid dispatch token");
  return mutate(ledger, now, () => {
    generation.state = "dispatching";
    generation.attempt = {
      attemptId: formatAttemptId(generation),
      token,
      dispatchStartedAt: now
    };
  });
}
function markDispatchUnknown(ledger, generationNumber, reason, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const generation = findGeneration(ledger, generationNumber);
  if (!generation || generation.state !== "dispatching") {
    throw new Error("Generation is not dispatching");
  }
  return mutate(ledger, now, () => {
    generation.state = "dispatch-unknown";
    const attempt = attemptOf(generation);
    attempt.unknownAt = now;
    attempt.unknownReason = reason;
  });
}
function markDispatchRejected(ledger, generationNumber, reason, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const generation = findGeneration(ledger, generationNumber);
  if (!generation || generation.state !== "dispatching") {
    throw new Error("Generation is not dispatching");
  }
  let promoted;
  mutate(ledger, now, () => {
    generation.state = "dispatch-rejected";
    const attempt = attemptOf(generation);
    attempt.rejectedAt = now;
    attempt.rejectionReason = reason;
    promoted = ledger.generations.find(
      (candidate) => candidate.state === "pending" && canDispatchOnAnchor(ledger, candidate)
    );
    if (promoted) promoted.state = "accepted";
  });
  return { ledger, promotedGeneration: promoted?.generation };
}
function restoreAcceptedForLaunchRetry(ledger, generationNumber, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const generation = findGeneration(ledger, generationNumber);
  if (!generation || !["dispatching", "dispatch-unknown"].includes(generation.state) || generation.attempt?.runId) {
    throw new Error("Generation is not an unbound launch attempt");
  }
  if (ledger.control.closed) {
    throw new Error("Closed anchor cannot retry a launch");
  }
  return mutate(ledger, now, () => {
    generation.state = "accepted";
    generation.attempt = void 0;
  });
}
function abandonPendingLaunchForClosedAnchor(ledger, generationNumber, reason, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const generation = findGeneration(ledger, generationNumber);
  if (!generation || !["dispatching", "dispatch-unknown"].includes(generation.state) || generation.attempt?.runId) {
    throw new Error("Generation is not an unbound launch attempt");
  }
  if (!ledger.control.closed) {
    throw new Error("Open anchor cannot abandon a pending launch");
  }
  return mutate(ledger, now, () => {
    generation.state = "superseded-by-close";
    const attempt = attemptOf(generation);
    attempt.rejectedAt = now;
    attempt.rejectionReason = reason;
  });
}
function bindRun(ledger, generationNumber, binding, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const generation = findGeneration(ledger, generationNumber);
  if (!generation || !["dispatching", "dispatch-unknown"].includes(generation.state)) {
    throw new Error("Generation is not awaiting a run binding");
  }
  if (!Number.isSafeInteger(binding.runId) || binding.runId <= 0 || typeof binding.runUrl !== "string" || typeof binding.htmlUrl !== "string") {
    throw new Error("Invalid workflow run binding");
  }
  return mutate(ledger, now, () => {
    generation.state = "active";
    Object.assign(attemptOf(generation), binding, { boundAt: now });
  });
}
function observeCompletion(ledger, generationNumber, runId, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const generation = findGeneration(ledger, generationNumber);
  if (!generation || !["active", "completion-observed", "completion-awaiting-terminal"].includes(
    generation.state
  ) || generation.attempt?.runId !== runId) {
    throw new Error("Completion does not match the active run");
  }
  return mutate(ledger, now, () => {
    generation.state = "completion-observed";
    attemptOf(generation).completionObservedAt ??= now;
  });
}
function awaitTerminal(ledger, generationNumber, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const generation = findGeneration(ledger, generationNumber);
  if (!generation || generation.state !== "completion-observed") {
    throw new Error("Completion has not been observed");
  }
  return mutate(ledger, now, () => {
    generation.state = "completion-awaiting-terminal";
    attemptOf(generation).lastObservedAt = now;
  });
}
function completeRun(ledger, generationNumber, observation, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const generation = findGeneration(ledger, generationNumber);
  if (!generation || !["active", "completion-observed", "completion-awaiting-terminal"].includes(
    generation.state
  ) || generation.attempt?.runId !== observation.runId || !TERMINAL_RUN_STATUSES.has(observation.status) || typeof observation.conclusion !== "string") {
    throw new Error("Invalid terminal run observation");
  }
  const conclusion = observation.conclusion;
  let promoted;
  mutate(ledger, now, () => {
    generation.state = "completed";
    const attempt = attemptOf(generation);
    attempt.status = observation.status;
    attempt.conclusion = conclusion;
    attempt.completedAt = observation.completedAt ?? now;
    promoted = ledger.generations.find(
      (candidate) => candidate.state === "pending" && canDispatchOnAnchor(ledger, candidate)
    );
    if (promoted) promoted.state = "accepted";
  });
  return { ledger, promotedGeneration: promoted?.generation };
}
function verifyPreflight(ledger, expected) {
  validateLedger(ledger, expected.task);
  const generation = findGeneration(ledger, expected.generation);
  return Boolean(
    generation && ["active", "completion-observed", "completion-awaiting-terminal"].includes(
      generation.state
    ) && generation.intentId === expected.intentId && generation.attempt?.token === expected.token && generation.attempt?.runId === expected.runId
  );
}

// apps/dispatch-broker/src/broker.ts
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function digest(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}
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
function applyAnchorControl(ledger, control, now = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!["closed", "reopened"].includes(control.kind))
    throw new Error("Invalid anchor control");
  if (!control.sourceId) throw new Error("Anchor control source ID missing");
  if (ledger.sources.some((source) => source.sourceId === control.sourceId)) {
    return { outcome: "duplicate", ledger };
  }
  mutate(ledger, now, () => {
    ledger.sources.push({
      sourceKind: control.kind,
      sourceId: control.sourceId,
      transportRunId: control.transportRunId,
      occurredAt: control.occurredAt,
      authorization: control.authorization
    });
    ledger.control = {
      closed: control.kind === "closed",
      sourceId: control.sourceId,
      occurredAt: control.occurredAt,
      merged: control.kind === "closed" && Boolean(control.merged)
    };
    if (control.kind === "closed") {
      for (const generation of ledger.generations) {
        if (generation.pipeline !== "canary" && (generation.state === "pending" || generation.state === "accepted")) {
          generation.state = "superseded-by-close";
        }
      }
    }
  });
  return { outcome: control.kind, ledger };
}
function recordControlEvidence(ledger, evidence, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const duplicate = ledger.sources.some(
    (source) => source.sourceKind === evidence.sourceKind && source.sourceId === evidence.sourceId
  );
  if (duplicate) return { outcome: "duplicate", ledger };
  mutate(ledger, now, () => ledger.sources.push(structuredClone(evidence)));
  return { outcome: "recorded", ledger };
}
function addAnomaly(ledger, kind, detail, now = (/* @__PURE__ */ new Date()).toISOString(), failure) {
  return mutate(ledger, now, () => {
    ledger.anomalies.push({
      kind,
      detail,
      occurredAt: now,
      ...failure === void 0 ? {} : { failure }
    });
  });
}

// apps/dispatch-broker/src/claude-readiness.ts
function classifyClaudeReadiness(actionConclusion, execution) {
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    return "unknown";
  }
  const result = execution;
  if (result.api_error_status === 401 && result.total_cost_usd === 0) {
    return "credential-failure";
  }
  if (actionConclusion === "success" && result.is_error === false) {
    return "healthy";
  }
  return "unknown";
}

// apps/dispatch-broker/src/github-api.ts
var API_VERSION = "2026-03-10";
var CONCURRENCY_VERIFY_MAX_ATTEMPTS = 5;
var CONCURRENCY_VERIFY_RETRY_DELAY_MS = 3e3;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
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
var LedgerProjectionRepairError = class extends Error {
  constructor(commentId, status) {
    super(
      `Failed to remove extra dispatch-ledger marker comment ${commentId}: HTTP ${status}`
    );
    this.commentId = commentId;
    this.status = status;
    this.name = "LedgerProjectionRepairError";
  }
  commentId;
  status;
};
var BrokerConcurrencyMismatchError = class extends Error {
  retryable;
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "BrokerConcurrencyMismatchError";
    this.retryable = retryable;
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
function brokerConcurrencyGroup(task) {
  if (!Number.isSafeInteger(task?.repositoryId) || task.repositoryId <= 0 || !Number.isSafeInteger(task?.issue) || task.issue <= 0) {
    throw new Error("Cannot derive broker concurrency group from TaskRef");
  }
  return `agent-lcars-dispatch-v1-${task.repositoryId}-${task.issue}`;
}
function assertSuppliedGroupMatches(suppliedGroup, expected) {
  if (suppliedGroup !== expected) {
    throw new BrokerConcurrencyMismatchError(
      "Broker concurrency output does not match its TaskRef"
    );
  }
}
function groupMembershipHolds(response, expected) {
  return (response?.concurrency_groups ?? []).filter(
    (group) => typeof group?.group_name === "string" && group.group_name.toLowerCase() === expected.toLowerCase()
  );
}
function concurrencyGroupsPath(root, runId) {
  return `${root}/actions/runs/${runId}/concurrency_groups?per_page=100`;
}
var ROUTER_BROKER_JOB_NAME = "broker";
async function findConflictingRouterRun(api2, task, runId) {
  const root = repositoryPath(task);
  const data = await api2.requestOk(
    `${root}/actions/workflows/agent-router.yml/runs?status=in_progress&per_page=100`
  );
  const candidates = (data.workflow_runs ?? []).filter((run) => {
    if (!Number.isSafeInteger(run?.id) || run.id === runId) return false;
    const marker = parseRouterGroupMarker(run.display_title);
    return marker !== void 0 && marker.repositoryId === task.repositoryId && marker.issue === task.issue;
  });
  for (const candidate of candidates) {
    const jobs = await api2.requestOk(
      `${root}/actions/runs/${candidate.id}/jobs?per_page=100`
    );
    const holdsGroup = (jobs.jobs ?? []).some(
      (job) => job?.name === ROUTER_BROKER_JOB_NAME && job.status === "in_progress"
    );
    if (holdsGroup) return candidate;
  }
  return void 0;
}
async function checkIndirectBrokerConcurrency(api2, task, runId, suppliedGroup) {
  const expected = brokerConcurrencyGroup(task);
  assertSuppliedGroupMatches(suppliedGroup, expected);
  const conflicting = await findConflictingRouterRun(api2, task, runId);
  if (conflicting) {
    throw new BrokerConcurrencyMismatchError(
      `Another in-progress agent-router.yml run (${conflicting.id}) carries this task's router-group marker for broker concurrency group ${expected}`,
      { retryable: true }
    );
  }
  return { group_name: expected, group_members: [] };
}
async function verifyBrokerConcurrency(api2, task, runId, suppliedGroup, {
  maxAttempts = CONCURRENCY_VERIFY_MAX_ATTEMPTS,
  retryDelayMs = CONCURRENCY_VERIFY_RETRY_DELAY_MS,
  sleepImpl = sleep,
  eventName
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await checkIndirectBrokerConcurrency(
        api2,
        task,
        runId,
        suppliedGroup
      );
      console.log(
        `::notice::Broker run ${runId}${eventName ? ` (event: ${eventName})` : ""} verified concurrency group ${suppliedGroup} indirectly, via its router-group marker on the run listing (#545). No other in-progress agent-router.yml run currently carries it.`
      );
      return result;
    } catch (error) {
      const candidate = error;
      const canRetry = candidate.retryable === true && attempt < maxAttempts;
      if (!canRetry) {
        if (attempt > 1) {
          candidate.message = `${candidate.message} (after ${attempt} attempts)`;
        }
        throw error;
      }
      await sleepImpl(retryDelayMs);
    }
  }
  throw new BrokerConcurrencyMismatchError(
    "Broker run does not report the expected concurrency group"
  );
}
var SUPERSEDING_RUN_CANDIDATE_LIMIT = 5;
async function findSupersedingRouterRun(api2, task, runId) {
  const expected = brokerConcurrencyGroup(task);
  const root = repositoryPath(task);
  const data = await api2.requestOk(
    `${root}/actions/workflows/agent-router.yml/runs?per_page=100`
  );
  const marker = `route #${task.issue}:`;
  const candidates = (data.workflow_runs ?? []).filter(
    (run) => Number.isSafeInteger(run?.id) && run.id > runId && typeof run.display_title === "string" && run.display_title.startsWith(marker)
  ).sort((left, right) => right.id - left.id).slice(0, SUPERSEDING_RUN_CANDIDATE_LIMIT);
  const inspections = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const response = await api2.requestOk(
          concurrencyGroupsPath(root, candidate.id)
        );
        return groupMembershipHolds(response, expected).length > 0 ? candidate : void 0;
      } catch {
        return void 0;
      }
    })
  );
  return inspections.find(Boolean);
}
async function listAll(api2, path) {
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const data = await api2.requestOk(
      `${path}${separator}per_page=100&page=${page}`
    );
    if (!Array.isArray(data))
      throw new Error("GitHub pagination response is not an array");
    all.push(...data);
    if (data.length < 100) return all;
  }
  throw new Error("GitHub pagination exceeded safety bound");
}
var workflowAlertMarker = (workflow) => `<!-- agent-lcars:workflow-alert:v1:${workflow} -->`;
var laneReadinessMarker = (pipeline) => `<!-- agent-lcars:lane-readiness:v1:${pipeline} -->`;
async function readLaneReadiness(api2, task, pipeline) {
  if (pipeline === "canary") return [];
  const expected = /* @__PURE__ */ new Map([
    [workflowAlertMarker("bootstrap-canary.yml"), "bootstrap-canary"],
    [laneReadinessMarker(pipeline), "lane-incident"]
  ]);
  if (pipeline === "opencode") {
    expected.set(
      workflowAlertMarker("opencode-model-canary.yml"),
      "provider-canary"
    );
  }
  const root = repositoryPath(task);
  const issues = await listAll(
    api2,
    `${root}/issues?state=open`
  );
  const blockers = [];
  for (const issue of issues) {
    if (issue.pull_request || typeof issue.body !== "string") continue;
    for (const [marker, source] of expected) {
      if (!issue.body.includes(marker)) continue;
      blockers.push({
        issue: issue.number,
        title: issue.title ?? `Readiness incident #${issue.number}`,
        url: issue.html_url ?? `https://github.com/${task.repository}/issues/${issue.number}`,
        source
      });
      break;
    }
  }
  return blockers.sort((left, right) => left.issue - right.issue);
}
async function ensureLaneReadinessAlert(api2, task, pipeline, failure, runUrl, maintainer, evidenceSource = "worker-completion") {
  if (pipeline === "canary") {
    throw new Error("The no-op canary cannot create an agent lane incident");
  }
  const marker = laneReadinessMarker(pipeline);
  const root = repositoryPath(task);
  const open = (await listAll(api2, `${root}/issues?state=open`)).filter(
    (issue) => !issue.pull_request && typeof issue.body === "string" && issue.body.includes(marker)
  ).sort((left, right) => left.number - right.number);
  if (open.length > 0) return open[0];
  const display = pipeline[0].toUpperCase() + pipeline.slice(1);
  const resumeTrigger = pipeline === "claude" ? "repair or rotate the credential. The isolated trusted Claude probe will close this incident only after a verified successful harness turn; scheduled reconcile will then resume held work automatically." : "repair or rotate the affected prerequisite, verify the lane is healthy, then close this issue. Scheduled reconcile will resume held accepted work automatically.";
  const observation = evidenceSource === "probe" ? "An isolated trusted harness probe reported" : "A trusted worker completion reported";
  return api2.requestOk(`${root}/issues`, {
    method: "POST",
    body: {
      title: `${display} agent lane is unavailable`,
      body: `${marker}

${observation} a shared **${failure}** readiness failure for the \`${pipeline}\` lane.

- First observed run: ${runUrl}
- Effect: the broker will not allocate another ${display} worker while this issue is open.
- Resume trigger: ${resumeTrigger}`,
      labels: ["status:needs-human"],
      ...maintainer ? { assignees: [maintainer] } : {}
    }
  });
}
async function resolveLaneReadinessAlerts(api2, task, pipeline, probeRunUrl) {
  if (pipeline === "canary") {
    throw new Error("The no-op canary cannot resolve an agent lane incident");
  }
  const marker = laneReadinessMarker(pipeline);
  const root = repositoryPath(task);
  const open = (await listAll(api2, `${root}/issues?state=open`)).filter(
    (issue) => !issue.pull_request && typeof issue.body === "string" && issue.body.includes(marker)
  ).sort((left, right) => left.number - right.number);
  for (const issue of open) {
    const recoveryEvidence = `- Verified recovery probe: ${probeRunUrl}`;
    const body = issue.body?.includes(recoveryEvidence) ? issue.body : `${issue.body?.trim() ?? marker}

${recoveryEvidence}`;
    await mutateOrVerify(
      () => api2.requestOk(`${root}/issues/${issue.number}`, {
        method: "PATCH",
        body: { body, state: "closed", state_reason: "completed" }
      }),
      async () => {
        const current = await api2.requestOk(
          `${root}/issues/${issue.number}`
        );
        return current.state === "closed";
      }
    );
  }
  return open;
}
function createReconcileTransport(api2) {
  return {
    listIssues: async (query) => {
      const root = repositoryPath({ repository: query.repository });
      const parameters = new URLSearchParams({
        state: query.state,
        per_page: String(query.perPage),
        page: String(query.page)
      });
      if (query.label) parameters.set("labels", query.label);
      if (query.assignee) parameters.set("assignee", query.assignee);
      if (query.since) parameters.set("since", query.since);
      return api2.requestOk(
        `${root}/issues?${parameters.toString()}`
      );
    },
    dispatchReconcile: (repository, issue) => dispatchRouterEvent(
      api2,
      { repository },
      {
        kind: "reconcile",
        issue: String(issue)
      }
    )
  };
}
async function loadLedger(api2, task, workflowIdentity = "github-actions[bot]", { createIfMissing = true } = {}) {
  const root = repositoryPath(task);
  const comments = await listAll(
    api2,
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
  const comment = await api2.requestOk(
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
async function loadLedgerProjection(api2, task, ledger, controllerIdentities = [
  { login: "github-actions[bot]", type: "Bot" }
]) {
  const root = repositoryPath(task);
  const comments = await listAll(
    api2,
    `${root}/issues/${task.issue}/comments`
  );
  const markerCandidates = comments.filter(
    (comment2) => comment2.body?.includes(LEDGER_MARKER)
  );
  const ownedCandidates = markerCandidates.filter(
    (comment2) => comment2.body?.includes(LEDGER_MARKER) && controllerIdentities.some(
      (identity) => comment2.user?.login === identity.login && comment2.user?.type === identity.type
    )
  ).sort((left, right) => left.id - right.id);
  let comment = ownedCandidates[0];
  let created = false;
  if (!comment) {
    comment = await api2.requestOk(
      `${root}/issues/${task.issue}/comments`,
      {
        method: "POST",
        body: { body: renderLedgerComment2(ledger) }
      }
    );
    if (!Number.isSafeInteger(comment?.id)) {
      throw new Error("GitHub did not return the created ledger comment ID");
    }
    created = true;
  }
  for (const duplicate of markerCandidates.filter(
    (candidate) => candidate.id !== comment.id
  )) {
    const response = await api2.request(
      `${root}/issues/comments/${duplicate.id}`,
      { method: "DELETE" }
    );
    if (response.status !== 404 && (response.status < 200 || response.status >= 300)) {
      throw new LedgerProjectionRepairError(duplicate.id, response.status);
    }
    console.log(
      `::notice::Removed extra dispatch-ledger marker comment ${duplicate.id}.`
    );
  }
  return {
    comment,
    ledger,
    created,
    ...created && { existingComments: comments }
  };
}
async function classifyAuthorityTaskInitialization(api2, task, authorityEpoch, controllerIdentities = [
  { login: "github-actions[bot]", type: "Bot" }
]) {
  const comments = await listAll(
    api2,
    `${repositoryPath(task)}/issues/${task.issue}/comments`
  );
  const hasProjection = comments.some(
    (comment) => comment.body?.includes(LEDGER_MARKER) && controllerIdentities.some(
      (identity) => comment.user?.login === identity.login && comment.user?.type === identity.type
    )
  );
  if (hasProjection) return "compatibility-projection";
  const epoch = Date.parse(authorityEpoch);
  if (!Number.isFinite(epoch)) {
    throw new Error(
      `DISPATCH_AUTHORITY_EPOCH must be a valid timestamp, got ${JSON.stringify(authorityEpoch)}`
    );
  }
  const issue = await api2.requestOk(
    `${repositoryPath(task)}/issues/${task.issue}`
  );
  const createdAt = Date.parse(issue.created_at);
  if (!Number.isFinite(createdAt)) {
    throw new Error(
      `GitHub returned an invalid created_at for ${task.repository}#${task.issue}`
    );
  }
  return createdAt >= epoch ? "post-cutover" : "pre-cutover";
}
async function saveLedger(api2, loaded) {
  const root = repositoryPath(loaded.ledger.task);
  const comment = await api2.requestOk(
    `${root}/issues/comments/${loaded.comment.id}`,
    {
      method: "PATCH",
      body: { body: renderLedgerComment2(loaded.ledger) }
    }
  );
  loaded.comment = comment;
  return loaded;
}
async function pinLedgerWhenUnoccupied(api2, loaded, isPullRequest) {
  if (!loaded.created || isPullRequest)
    return { pinned: false, reason: "ineligible" };
  const { existingComments } = loaded;
  if (!existingComments) {
    throw new Error(
      "LoadedLedger.existingComments missing despite created=true"
    );
  }
  if (existingComments.some((comment) => comment.pin)) {
    return { pinned: false, reason: "occupied" };
  }
  const root = repositoryPath(loaded.ledger.task);
  try {
    await api2.requestOk(`${root}/issues/comments/${loaded.comment.id}/pin`, {
      method: "PUT"
    });
    return { pinned: true };
  } catch (error) {
    return {
      pinned: false,
      // Every requestOk failure throws a GitHubApiError (see request()
      // above); this mirrors the untyped original's own optional-chained
      // `error.status` read for anything else.
      reason: `best-effort-failed:${error instanceof GitHubApiError ? error.status ?? "transport" : "transport"}`
    };
  }
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
async function dispatchRouterEvent(api2, task, inputs) {
  const response = await api2.request(
    `${repositoryPath(task)}/actions/workflows/agent-router.yml/dispatches`,
    {
      method: "POST",
      body: { ref: "main", inputs }
    }
  );
  return validateDispatchResponse(response, task);
}
function attemptOf2(generation) {
  const { attempt } = generation;
  if (!attempt) {
    throw new Error(`Generation ${generation.generation} has no attempt`);
  }
  return attempt;
}
async function dispatchWorker(api2, generation, task) {
  const workflow = workerWorkflow(generation.pipeline);
  const root = repositoryPath(task);
  const response = await api2.request(
    `${root}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: "POST",
      body: {
        ref: "main",
        inputs: {
          issue: String(task.issue),
          mode: generation.mode,
          reply: generation.reply ?? "",
          runbook: generation.runbook ?? "",
          context: generation.context ?? "",
          broker_intent_id: generation.intentId,
          broker_generation: String(generation.generation),
          // `beginDispatch` (modules/scheduler.mjs) always sets `attempt`
          // together with the `dispatching` state a generation is in by
          // the time dispatchAccepted (main.mjs) calls this -- same
          // assumption the untyped original made without checking.
          broker_dispatch_token: attemptOf2(generation).token
        }
      }
    }
  );
  return { ...validateDispatchResponse(response, task), workflow };
}
async function getWorkflowRun(api2, task, runId) {
  return api2.requestOk(
    `${repositoryPath(task)}/actions/runs/${runId}`
  );
}
var FIND_RUNS_FOR_GENERATION_MAX_PAGES = 5;
var FIND_RUNS_FOR_GENERATION_CREATED_BUFFER_MS = 5 * 60 * 1e3;
function createdAtOrAfterFilter(generation) {
  const dispatchedAt = generation.attempt?.dispatchStartedAt ?? generation.occurredAt;
  const parsed = Date.parse(dispatchedAt);
  if (Number.isNaN(parsed)) return "";
  const scoped = new Date(
    parsed - FIND_RUNS_FOR_GENERATION_CREATED_BUFFER_MS
  ).toISOString();
  return `&created=${encodeURIComponent(`>=${scoped}`)}`;
}
async function findRunsForGeneration(api2, task, generation) {
  const workflow = workerWorkflow(generation.pipeline);
  const root = repositoryPath(task);
  const createdFilter = createdAtOrAfterFilter(generation);
  const matches = [];
  for (let page = 1; page <= FIND_RUNS_FOR_GENERATION_MAX_PAGES; page += 1) {
    const data = await api2.requestOk(
      `${root}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch${createdFilter}&per_page=100&page=${page}`
    );
    const runs = data.workflow_runs ?? [];
    for (const run of runs) {
      if (displayTitleMatchesAttempt(run.display_title, generation)) {
        matches.push(run);
      }
    }
    if (runs.length < 100) break;
  }
  return matches;
}
async function removeIssueLabel(api2, task, label) {
  const root = repositoryPath(task);
  const response = await api2.request(
    `${root}/issues/${task.issue}/labels/${encodeURIComponent(label)}`,
    { method: "DELETE" }
  );
  if (response.status === 404) return { removed: false };
  if (response.status < 200 || response.status >= 300) {
    throw new GitHubApiError(
      `Failed to remove stale label ${label}: HTTP ${response.status}`,
      response.status,
      response.data
    );
  }
  return { removed: true };
}
async function failClosed(api2, task, maintainer, error) {
  const originalError = error instanceof Error ? error : new Error(String(error));
  let fallbackError;
  try {
    await ensureNeedsHumanParked(api2, task, maintainer);
  } catch (parkingError) {
    fallbackError = parkingError instanceof Error ? parkingError : new Error(String(parkingError));
  }
  if (fallbackError) {
    throw new AggregateError(
      [originalError, fallbackError],
      `Dispatch broker failed (${originalError.message}); fail-closed parking also failed (${fallbackError.message})`,
      { cause: originalError }
    );
  }
  throw originalError;
}
async function issueHasLabel(api2, task, label) {
  const issue = await api2.requestOk(
    `${repositoryPath(task)}/issues/${task.issue}`
  );
  return (issue.labels ?? []).some(
    (entry) => (typeof entry === "string" ? entry : entry.name) === label
  );
}
async function issueHasAssignee(api2, task, login) {
  const issue = await api2.requestOk(
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
async function ensureNeedsHumanParked(api2, task, maintainer) {
  const root = repositoryPath(task);
  await mutateOrVerify(
    () => api2.requestOk(`${root}/issues/${task.issue}/labels`, {
      method: "POST",
      body: { labels: ["status:needs-human"] }
    }),
    () => issueHasLabel(api2, task, "status:needs-human")
  );
  if (!maintainer) return;
  await mutateOrVerify(
    () => api2.requestOk(`${root}/issues/${task.issue}/assignees`, {
      method: "POST",
      body: { assignees: [maintainer] }
    }),
    () => issueHasAssignee(api2, task, maintainer)
  );
}

// apps/dispatch-broker/src/hosted-completion-client.ts
var HostedCompletionRequestError = class extends Error {
  constructor(message, retryable) {
    super(message);
    this.retryable = retryable;
    this.name = "HostedCompletionRequestError";
  }
  retryable;
};
function validatedHttpsUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HostedCompletionRequestError(`${name} is not a valid URL`, false);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new HostedCompletionRequestError(
      `${name} must be an HTTPS URL without credentials or a fragment`,
      false
    );
  }
  return url;
}
function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}
async function withRetry(operation, {
  maxAttempts,
  sleep: sleep2
}) {
  let delay = 1e3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryable = !(error instanceof HostedCompletionRequestError) || error.retryable;
      if (!retryable || attempt === maxAttempts) throw error;
      await sleep2(delay);
      delay *= 2;
    }
  }
  throw new Error("Hosted completion retry loop exhausted unexpectedly");
}
async function requestOidcToken({
  oidcRequestUrl,
  oidcRequestToken,
  fetchImpl,
  sleep: sleep2,
  timeoutMs,
  maxAttempts
}) {
  const url = validatedHttpsUrl(oidcRequestUrl, "GitHub OIDC request URL");
  url.searchParams.set("audience", COMPLETION_OIDC_AUDIENCE);
  return withRetry(
    async () => {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${oidcRequestToken}`
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        throw new HostedCompletionRequestError(
          `GitHub OIDC token request failed with HTTP ${response.status}`,
          retryableStatus(response.status)
        );
      }
      const body = await response.json();
      if (typeof body.value !== "string" || body.value.length === 0) {
        throw new HostedCompletionRequestError(
          "GitHub OIDC token response did not contain a token",
          false
        );
      }
      return body.value;
    },
    { maxAttempts, sleep: sleep2 }
  );
}
async function sendHostedCompletion({
  payload,
  oidcRequestUrl,
  oidcRequestToken,
  completionUrl = HOSTED_COMPLETION_URL,
  fetchImpl = fetch,
  sleep: sleep2 = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = 15e3,
  maxAttempts = 3
}) {
  const endpoint = validatedHttpsUrl(
    completionUrl,
    "Hosted completion endpoint"
  );
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new HostedCompletionRequestError(
      "Hosted completion maxAttempts must be positive",
      false
    );
  }
  const idToken = await requestOidcToken({
    oidcRequestUrl,
    oidcRequestToken,
    fetchImpl,
    sleep: sleep2,
    timeoutMs,
    maxAttempts
  });
  await withRetry(
    async () => {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        throw new HostedCompletionRequestError(
          `Hosted completion request failed with HTTP ${response.status}`,
          retryableStatus(response.status)
        );
      }
    },
    { maxAttempts, sleep: sleep2 }
  );
}

// apps/dispatch-broker/src/modules/projector.ts
function projectionMarker(kind, key) {
  return `<!-- agent-lcars:projection:${kind}:${key} -->`;
}
async function projectComment(api2, task, kind, key, render) {
  const marker = projectionMarker(kind, key);
  const root = repositoryPath(task);
  const comments = await listAll(
    api2,
    `${root}/issues/${task.issue}/comments`
  );
  const existing = comments.filter((comment) => comment.body?.includes(marker));
  if (existing.length > 1) {
    throw new Error(
      `Duplicate ${kind} projection comment on issue #${task.issue} for key ${key}`
    );
  }
  const body = render(marker);
  if (existing.length === 1) {
    const updated = await api2.requestOk(
      `${root}/issues/comments/${existing[0].id}`,
      { method: "PATCH", body: { body } }
    );
    return { id: updated.id, action: "updated" };
  }
  const created = await api2.requestOk(
    `${root}/issues/${task.issue}/comments`,
    { method: "POST", body: { body } }
  );
  return { id: created.id, action: "created" };
}
async function projectNeedsHumanPark(api2, task, maintainer, failure) {
  if (!needsMaintainer(failure)) return { parked: false };
  await ensureNeedsHumanParked(api2, task, maintainer);
  return { parked: true };
}
function recordProjectionStatus(ledger, converged, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const desiredRevision = ledger.revision;
  const observedRevision = converged ? desiredRevision : ledger.projection?.observedRevision ?? 0;
  return mutate(ledger, now, () => {
    ledger.projection = {
      desiredRevision,
      observedRevision,
      state: converged ? "converged" : observedRevision > 0 ? "diverged" : "pending",
      observedAt: now
    };
  });
}

// apps/dispatch-broker/src/normalize.ts
import crypto2 from "node:crypto";

// apps/dispatch-broker/src/modules/authorization.ts
var AUTHORIZATION_RULES = Object.freeze({
  MANUAL_MAINTAINER: "manual-maintainer",
  OWNER_COMMENT: "owner-comment",
  MAINTAINER_ISSUE_EVENT: "maintainer-issue-event",
  CANARY_SCHEDULED_DISPATCH: "canary-scheduled-dispatch",
  RECONCILE_LABEL_REPAIR: "reconcile-label-repair"
});
function authorization(actor, maintainer, rule, extra = {}) {
  return {
    authorized: actor === maintainer,
    actor,
    configuredMaintainer: maintainer,
    rule,
    ...extra
  };
}

// apps/dispatch-broker/src/normalize.ts
function isWebhookIngressCanary(issue) {
  return Boolean(
    issue && issue.title === WEBHOOK_INGRESS_CANARY_TITLE && issue.body?.includes(WEBHOOK_INGRESS_CANARY_MARKER)
  );
}
var COMMANDS = new Map([...REPLY_COMMANDS, [GENERIC_REPLY_COMMAND, null]]);
var WORKER_WORKFLOWS = WORKER_WORKFLOW_FILES;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
var sha256Hex = (input) => crypto2.createHash("sha256").update(input).digest("hex");
function labelsOf(issue) {
  return (issue.labels ?? []).map(
    (label) => typeof label === "string" ? label : label.name
  );
}
function selectedPipelineFrom(labels, labelMap) {
  const selected = labels.filter((label) => labelMap.has(label)).map((label) => labelMap.get(label));
  return selected.length === 1 ? selected[0] : void 0;
}
function selectedPipeline(issue) {
  return selectedPipelineFrom(labelsOf(issue), AGENT_LABELS);
}
function parseExactCommand(body) {
  let fenced = false;
  const matches = [];
  for (const rawLine of body.split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.startsWith(">")) continue;
    for (const [command, pipeline] of COMMANDS) {
      if (line === command || line.startsWith(`${command} `)) {
        matches.push({ command, pipeline });
      }
    }
  }
  if (matches.length !== 1) return void 0;
  return matches[0];
}
function quickTaskRequest(issue, repository, pipeline) {
  const body = issue.body ?? "";
  const matches = [...body.matchAll(quickTaskMarkerMatcher())];
  if (matches.length === 0) {
    if (body.includes("<!-- agent-lcars:quick-task-request:v1")) {
      throw new Error("Malformed Quick Task marker");
    }
    return void 0;
  }
  if (matches.length !== 1 || !pipeline) {
    throw new Error("Malformed Quick Task marker or agent-label selection");
  }
  const [marker, requestId, persistedDigest] = matches[0];
  const description = body.slice(0, matches[0].index).trim();
  const originalPipeline = [...AGENT_LABELS.values()].find(
    (candidate) => digestQuickTask({
      repository,
      pipeline: candidate,
      title: issue.title,
      description
    }) === persistedDigest
  );
  if (!originalPipeline) {
    throw new Error("Quick Task marker digest mismatch");
  }
  const matchIndex = matches[0].index;
  if (matchIndex === void 0) {
    throw new Error("Quick Task marker match unexpectedly missing its index");
  }
  if (body.slice(matchIndex + marker.length).trim()) {
    throw new Error("Quick Task marker must be the final body element");
  }
  if (originalPipeline !== pipeline) return void 0;
  return { requestId, digest: persistedDigest };
}
function digestQuickTask(identity) {
  return quickTaskDigest(identity, sha256Hex);
}
function timelineSource(timeline, eventName, event) {
  const action = event.action;
  const numbered = event.issue ?? event.pull_request;
  if (!numbered) {
    throw new Error(
      `${eventName}:${action} timeline lookup missing issue/pull_request`
    );
  }
  const targetTime = Date.parse(numbered.updated_at);
  const candidates = timeline.filter((candidate) => {
    if (candidate.event !== action) return false;
    if (["labeled", "unlabeled"].includes(action)) {
      if (candidate.label?.name !== event.label?.name) return false;
      if (candidate.actor?.login !== event.sender?.login) return false;
    }
    const occurredAt = Date.parse(candidate.created_at);
    return Number.isFinite(targetTime) && Number.isFinite(occurredAt) && Math.abs(occurredAt - targetTime) <= 1e4;
  });
  if (candidates.length !== 1 || !candidates[0].id) {
    throw new Error(`Ambiguous ${eventName}:${action} timeline event`);
  }
  return {
    sourceId: `timeline:${candidates[0].id}`,
    occurredAt: candidates[0].created_at
  };
}
function resolveCallerSourceId(inputs, context, label) {
  const sourceId = inputs.caller_id || `actions-run:${context.runId}`;
  if (inputs.caller_id && !UUID.test(inputs.caller_id)) {
    throw new Error(`${label} caller ID must be a UUID`);
  }
  return sourceId;
}
function taskRef(context, issue) {
  const repository = context.repository;
  const repositoryId = Number(context.repositoryId);
  const issueNumber = Number(issue?.number ?? context.issue);
  return { repositoryId, repository, issue: issueNumber };
}
function makeIntent(base) {
  const normalizedPayload = {
    task: base.task,
    pipeline: base.pipeline,
    mode: base.mode,
    reply: base.reply ?? "",
    runbook: base.runbook ?? "",
    context: base.context ?? ""
  };
  return {
    ...base,
    ...normalizedPayload,
    digest: digest(normalizedPayload),
    intentId: base.intentId ?? `intent:${digest({ ...normalizedPayload, sourceId: base.sourceId })}`
  };
}
function normalizeWorkflowDispatch({
  inputs,
  context,
  maintainer,
  issue
}) {
  const task = taskRef(context, void 0);
  if (inputs.kind === "reconcile") {
    return {
      kind: "reconcile",
      task,
      // Omit the key entirely rather than `issueClosed: undefined` when the
      // live state can't be read -- a manual/forensic dispatch that somehow
      // reaches here without a fetched issue must fall back to
      // reconcileControlState's own "unknown" handling (main.mjs), not a
      // stray explicit `undefined` that changes this object's own shape.
      ...issue?.state === "open" || issue?.state === "closed" ? { issueClosed: issue.state === "closed" } : {}
    };
  }
  if (inputs.kind === "completion") {
    let completion;
    try {
      completion = JSON.parse(
        Buffer.from(inputs.completion_payload, "base64url").toString(
          "utf8"
        )
      );
    } catch {
      throw new Error("Completion payload is malformed");
    }
    const candidate = completion;
    if (!Number.isSafeInteger(candidate.workerRunId) || candidate.workerRunId <= 0 || !Number.isSafeInteger(candidate.generation) || candidate.generation <= 0 || !/^[A-Za-z0-9._:-]{1,200}$/u.test(candidate.intentId ?? "") || !/^[A-Za-z0-9_-]{16,200}$/u.test(candidate.token ?? "") || !WORKER_WORKFLOWS.has(candidate.workflow) || candidate.outcome !== void 0 && !isDispatchOutcomeKind(candidate.outcome) || candidate.outcomeReference !== void 0 && !isDispatchOutcomeReference(candidate.outcomeReference) || candidate.outcomeReference !== void 0 && candidate.outcome !== "pull-request" || candidate.readinessFailure !== void 0 && !isLaneReadinessFailure(candidate.readinessFailure)) {
      throw new Error("Completion payload has invalid binding fields");
    }
    return {
      kind: "completion",
      task,
      sourceKind: "completion",
      sourceId: `worker-run:${candidate.workerRunId}`,
      transportRunId: context.runId,
      workerRunId: candidate.workerRunId,
      generation: candidate.generation,
      intentId: candidate.intentId,
      token: candidate.token,
      workflow: candidate.workflow,
      ...candidate.outcome ? { outcome: candidate.outcome } : {},
      ...candidate.outcomeReference ? { outcomeReference: candidate.outcomeReference } : {},
      ...candidate.readinessFailure ? { readinessFailure: candidate.readinessFailure } : {}
    };
  }
  if (inputs.kind === "canary") {
    const sourceId2 = resolveCallerSourceId(inputs, context, "Canary dispatch");
    return {
      kind: "intent",
      intent: makeIntent({
        task,
        sourceKind: "canary",
        sourceId: sourceId2,
        transportRunId: context.runId,
        occurredAt: context.now,
        pipeline: "canary",
        mode: "implement",
        reply: "",
        runbook: "",
        context: "",
        authorization: {
          authorized: true,
          actor: context.actor,
          configuredMaintainer: maintainer,
          rule: AUTHORIZATION_RULES.CANARY_SCHEDULED_DISPATCH
        }
      })
    };
  }
  const sourceId = resolveCallerSourceId(inputs, context, "Manual dispatch");
  const auth = authorization(
    context.actor,
    maintainer,
    AUTHORIZATION_RULES.MANUAL_MAINTAINER
  );
  if (!auth.authorized) throw new Error("Unauthorized manual dispatch");
  if (!AGENT_LABELS.has(`agent:${inputs.pipeline}`)) {
    throw new Error("Unsupported manual dispatch pipeline");
  }
  return {
    kind: "intent",
    intent: makeIntent({
      task,
      sourceKind: "manual",
      sourceId,
      transportRunId: context.runId,
      occurredAt: context.now,
      // Validated two lines up: AGENT_LABELS' keys are exactly
      // `agent:claude`/`agent:codex`/`agent:opencode`, so the has() check
      // above already proved inputs.pipeline is one of those three names.
      pipeline: inputs.pipeline,
      mode: inputs.mode || "implement",
      reply: inputs.reply || "",
      runbook: inputs.runbook || "",
      context: inputs.context || "",
      authorization: auth
    })
  };
}
function normalizeEvent({
  eventName,
  event,
  inputs = {},
  context,
  timeline = [],
  maintainer
}) {
  const semanticEventName = eventName === "pull_request_target" ? "pull_request" : eventName;
  const issue = event.issue ?? event.pull_request;
  if (isWebhookIngressCanary(issue) && !(semanticEventName === "issues" && ["closed", "reopened"].includes(event.action))) {
    return { kind: "ignored", reason: "webhook ingress canary sentinel" };
  }
  if (semanticEventName === "workflow_dispatch") {
    return normalizeWorkflowDispatch({
      inputs,
      context,
      maintainer,
      issue: event.issue
    });
  }
  if (!issue) return { kind: "ignored", reason: "event has no issue" };
  const task = taskRef(context, issue);
  const pipeline = selectedPipeline(issue);
  if (semanticEventName === "issue_comment" && event.action === "created") {
    const parsed = parseExactCommand(event.comment?.body ?? "");
    if (!parsed) return { kind: "ignored", reason: "no exact agent command" };
    const resolvedPipeline = parsed.pipeline ?? pipeline;
    if (!resolvedPipeline) {
      throw new Error(
        "Generic @agent command has no unambiguous agent:* label to resolve against"
      );
    }
    const isPullRequest = Boolean(issue.pull_request);
    if (pipeline !== resolvedPipeline && !(isPullRequest && resolvedPipeline === "claude")) {
      throw new Error(
        "Comment command does not match the selected integration"
      );
    }
    const comment = event.comment;
    if (!comment) {
      throw new Error("issue_comment:created event missing comment");
    }
    const auth2 = authorization(
      event.sender?.login,
      maintainer,
      AUTHORIZATION_RULES.OWNER_COMMENT,
      {
        association: comment.author_association,
        userType: comment.user?.type
      }
    );
    if (!auth2.authorized || auth2.association !== "OWNER" || auth2.userType === "Bot") {
      throw new Error("Unauthorized comment dispatch");
    }
    return {
      kind: "intent",
      intent: makeIntent({
        task,
        sourceKind: "comment",
        sourceId: `comment:${comment.id}`,
        transportRunId: context.runId,
        occurredAt: comment.created_at,
        pipeline: resolvedPipeline,
        mode: "reply",
        reply: comment.body,
        runbook: "",
        context: "",
        authorization: auth2
      })
    };
  }
  if (semanticEventName === "pull_request") {
    if (["closed", "reopened"].includes(event.action)) {
      if (!issue.id || Number.isNaN(Date.parse(issue.updated_at))) {
        throw new Error("Malformed pull request anchor event");
      }
      return {
        kind: "anchor-control",
        task,
        control: {
          // Array.prototype.includes() doesn't narrow a string the way an
          // === chain does; the check two lines up already restricts
          // event.action to exactly these two values.
          kind: event.action,
          sourceId: `pull-request:${issue.id}:${event.action}:${issue.updated_at}`,
          occurredAt: issue.updated_at,
          transportRunId: context.runId,
          authorization: { observed: true, actor: event.sender?.login },
          merged: event.action === "closed" && Boolean(issue.merged)
        }
      };
    }
    if (!["labeled", "unlabeled"].includes(event.action)) {
      return { kind: "ignored", reason: "unsupported pull request action" };
    }
  }
  if (!["issues", "pull_request"].includes(semanticEventName))
    return { kind: "ignored", reason: "unsupported event" };
  const auth = authorization(
    event.sender?.login,
    maintainer,
    AUTHORIZATION_RULES.MAINTAINER_ISSUE_EVENT
  );
  if (event.action === "opened") {
    const quickTask = quickTaskRequest(issue, context.repository, pipeline);
    if (!quickTask) return { kind: "ignored", reason: "ordinary opened issue" };
    if (!auth.authorized)
      throw new Error("Unauthorized Quick Task opened event");
    return {
      kind: "intent",
      intent: makeIntent({
        task,
        intentId: `quick:${quickTask.requestId}:${quickTask.digest}`,
        sourceKind: "opened",
        sourceId: `issue:${issue.id}`,
        transportRunId: context.runId,
        occurredAt: issue.created_at,
        // quickTaskRequest() above only ever returns a result when its own
        // `pipeline` argument (this same variable) was truthy -- otherwise
        // it throws before returning -- so `pipeline` is proven defined by
        // `quickTask` having a value at all.
        pipeline,
        mode: "implement",
        reply: "",
        runbook: "",
        context: "",
        authorization: auth
      })
    };
  }
  if (["labeled", "unlabeled", "closed", "reopened"].includes(event.action)) {
    const source = timelineSource(timeline, semanticEventName, event);
    if (event.action === "closed" || event.action === "reopened") {
      return {
        kind: "anchor-control",
        task,
        control: {
          kind: event.action,
          ...source,
          transportRunId: context.runId,
          authorization: { observed: true, actor: event.sender?.login },
          merged: Boolean(issue.pull_request && issue.merged_at)
        }
      };
    }
    const labelName = event.label?.name;
    const isReviewLabel = semanticEventName === "pull_request" && Boolean(labelName?.startsWith("review:"));
    if (labelName === "status:needs-human") {
      return {
        kind: "control-evidence",
        task,
        evidence: {
          sourceKind: event.action,
          ...source,
          transportRunId: context.runId,
          label: labelName,
          authorization: { observed: true, actor: event.sender?.login }
        }
      };
    }
    if (!labelName?.startsWith("agent:") && !isReviewLabel) {
      return { kind: "ignored", reason: "non-agent label event" };
    }
    if (!labelName) {
      throw new Error("Label event missing its own label name");
    }
    const labelMap = isReviewLabel ? REVIEW_LABELS : AGENT_LABELS;
    const labelKind = isReviewLabel ? "review" : "agent";
    if (event.action === "unlabeled") {
      return {
        kind: "control-evidence",
        task,
        evidence: {
          sourceKind: "unlabeled",
          ...source,
          transportRunId: context.runId,
          label: labelName,
          authorization: { observed: true, actor: event.sender?.login }
        }
      };
    }
    if (!auth.authorized) throw new Error("Unauthorized label dispatch");
    const eventPipeline = labelMap.get(labelName);
    if (!eventPipeline)
      return { kind: "ignored", reason: `unknown ${labelKind} label` };
    const selectedLabelsInNamespace = labelsOf(issue).filter(
      (label) => labelMap.has(label)
    );
    let effectivePipeline = selectedPipelineFrom(labelsOf(issue), labelMap);
    let staleAgentLabels;
    if (selectedLabelsInNamespace.length > 1) {
      const otherLabelsInNamespace = selectedLabelsInNamespace.filter(
        (label) => label !== labelName
      );
      if (!selectedLabelsInNamespace.includes(labelName) || otherLabelsInNamespace.length !== 1) {
        throw new Error(`Issue has contradictory ${labelKind} labels`);
      }
      staleAgentLabels = otherLabelsInNamespace;
      effectivePipeline = eventPipeline;
    }
    const quickTask = quickTaskRequest(
      issue,
      context.repository,
      effectivePipeline
    );
    return {
      kind: "intent",
      intent: makeIntent({
        task,
        ...quickTask && {
          intentId: `quick:${quickTask.requestId}:${quickTask.digest}`
        },
        sourceKind: "labeled",
        ...source,
        transportRunId: context.runId,
        pipeline: eventPipeline,
        mode: isReviewLabel ? "review" : "implement",
        reply: "",
        runbook: "",
        context: "",
        dispatchable: effectivePipeline === eventPipeline,
        ...staleAgentLabels && { staleAgentLabels },
        authorization: auth
      })
    };
  }
  return { kind: "ignored", reason: "unsupported issue action" };
}

// apps/dispatch-broker/src/storage/port.ts
function taskKey(task) {
  return `${task.repositoryId}:${task.issue}`;
}
var TaskWriteConflictError = class extends Error {
  constructor(task, expectedRevision, actualRevision) {
    super(
      `Task write conflict for ${task.repository}#${task.issue}: expected revision ${expectedRevision ?? "(none)"}, found ${actualRevision ?? "(none)"}`
    );
    this.task = task;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
    this.name = "TaskWriteConflictError";
  }
  task;
  expectedRevision;
  actualRevision;
};

// apps/dispatch-broker/src/storage/shadow.ts
import { isDeepStrictEqual } from "node:util";
function parseDispatchStorageMode(raw) {
  const value = (raw ?? "").trim();
  if (value === "" || value === "off") return "off";
  if (value === "shadow") return "shadow";
  if (value === "authority") return "authority";
  throw new Error(
    `Unrecognized DISPATCH_STORAGE_MODE '${raw}': expected 'off' (or unset), 'shadow', or 'authority'.`
  );
}
function mapGenerationState(state) {
  switch (state) {
    case "accepted":
      return "accepted";
    case "pending":
      return "pending";
    case "dispatching":
    case "dispatch-unknown":
      return "dispatching";
    case "active":
    case "completion-observed":
    case "completion-awaiting-terminal":
      return "active";
    case "completed":
      return "completed";
    case "dispatch-rejected":
    case "superseded":
    case "superseded-by-close":
      return "superseded";
    default: {
      const exhaustive = state;
      throw new Error(
        `Unhandled ledger generation state: ${String(exhaustive)}`
      );
    }
  }
}
function mapAuthorization(authorization2) {
  if (!authorization2) return { observed: true };
  if ("authorized" in authorization2) {
    return {
      authorized: authorization2.authorized,
      actor: authorization2.actor,
      rule: authorization2.rule
    };
  }
  return {
    observed: true,
    actor: authorization2.actor,
    workflow: authorization2.workflow
  };
}
function mapSignal(source) {
  return {
    sourceKind: source.sourceKind,
    sourceId: source.sourceId,
    occurredAt: source.occurredAt,
    authorization: mapAuthorization(source.authorization)
  };
}
function mapAttempt(generation) {
  const attempt = generation.attempt;
  if (!attempt) return void 0;
  return {
    attemptId: attempt.attemptId ?? formatAttemptId({
      generation: generation.generation,
      intentId: generation.intentId
    }),
    token: attempt.token ?? "",
    dispatchStartedAt: attempt.dispatchStartedAt ?? generation.occurredAt,
    runId: attempt.runId,
    runUrl: attempt.runUrl,
    htmlUrl: attempt.htmlUrl,
    boundAt: attempt.boundAt,
    completedAt: attempt.completedAt,
    conclusion: attempt.conclusion,
    outcome: attempt.outcome,
    outcomeReference: attempt.outcomeReference
  };
}
function mapIntent(generation) {
  return {
    intentId: generation.intentId,
    sourceId: generation.sourceId,
    occurredAt: generation.occurredAt,
    state: mapGenerationState(generation.state),
    attempt: mapAttempt(generation)
  };
}
function projectLedgerToStoredTask(ledger) {
  const activeGeneration2 = ledger.generations.find(
    (generation) => LEDGER_ACTIVE_GENERATION_STATES.has(generation.state)
  );
  const pendingGeneration = ledger.generations.find(
    (generation) => generation.state === "pending"
  );
  const acceptedGeneration = ledger.generations.find(
    (generation) => generation.state === "accepted"
  );
  const desiredIntentId = activeGeneration2?.intentId ?? pendingGeneration?.intentId ?? acceptedGeneration?.intentId;
  return {
    desiredIntentId,
    signals: ledger.sources.map(mapSignal),
    intents: ledger.generations.map(mapIntent),
    controllerState: structuredClone(ledger)
  };
}
function storageComparable(value) {
  if (Array.isArray(value)) {
    return value.filter((element) => element !== void 0).map(storageComparable);
  }
  if (value && typeof value === "object") {
    const comparable = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      if (fieldValue === void 0) continue;
      comparable[key] = storageComparable(fieldValue);
    }
    return comparable;
  }
  return value;
}
function checkRoundTrip(written, after) {
  if (!after) {
    return [
      { field: "revision", expected: written.revision, actual: void 0 }
    ];
  }
  const fields = ["desiredIntentId", "signals", "intents", "controllerState"];
  const divergences = [];
  for (const field of fields) {
    const expected = written[field];
    const actual = after[field];
    if (!isDeepStrictEqual(storageComparable(expected), storageComparable(actual))) {
      divergences.push({ field, expected, actual });
    }
  }
  if (after.revision !== written.revision) {
    divergences.push({
      field: "revision",
      expected: written.revision,
      actual: after.revision
    });
  }
  return divergences;
}
function logRoundTripMismatches(task, divergences) {
  for (const divergence of divergences) {
    console.log(
      `::warning::dispatch-storage shadow round-trip mismatch for ${task.repository}#${task.issue}, field '${divergence.field}': expected=${JSON.stringify(divergence.expected)} actual=${JSON.stringify(divergence.actual)}`
    );
  }
}
async function observeDispatchStorage(port, ledger, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const task = ledger.task;
  const before = await port.readTask(task);
  const desired = projectLedgerToStoredTask(ledger);
  const written = await port.writeTask(task, before?.revision, desired, now);
  const after = await port.readTask(task);
  logRoundTripMismatches(task, checkRoundTrip(written, after));
}
async function maybeObserveDispatchStorage(mode, createPort, ledger, now) {
  if (mode !== "shadow") return;
  try {
    await observeDispatchStorage(createPort(), ledger, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `::warning::dispatch-storage shadow observation failed for ${ledger.task.repository}#${ledger.task.issue}: ${message}`
    );
  }
}

// apps/dispatch-broker/src/storage/authority.ts
var DEFAULT_TASK_LEASE_MS = 2 * 60 * 1e3;
var DEFAULT_CAS_ATTEMPTS = 8;
var TaskLeaseBusyError = class extends Error {
  constructor(task, lease) {
    super(
      `Task ${task.repository}#${task.issue} is already leased by ${lease.owner} until ${lease.expiresAt}`
    );
    this.task = task;
    this.lease = lease;
    this.name = "TaskLeaseBusyError";
  }
  task;
  lease;
};
var AuthorityStateNotFoundError = class extends Error {
  constructor(task) {
    super(
      `No authoritative controller state exists for ${task.repository}#${task.issue}`
    );
    this.task = task;
    this.name = "AuthorityStateNotFoundError";
  }
  task;
};
var AuthorityStateMissingError = class extends Error {
  constructor(task, compatibilityQuiescent = false) {
    super(
      `Task ${task.repository}#${task.issue} has existing compatibility state but no exact authoritative controller state; return to shadow mode and backfill it before authority cutover`
    );
    this.task = task;
    this.compatibilityQuiescent = compatibilityQuiescent;
    this.name = "AuthorityStateMissingError";
  }
  task;
  compatibilityQuiescent;
};
function leaseIsLive(lease, now) {
  return Boolean(lease && Date.parse(lease.expiresAt) > Date.parse(now));
}
async function acquireAuthority(port, task, owner, seed, options = {}) {
  const now = options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  const leaseMs = options.leaseMs ?? DEFAULT_TASK_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_CAS_ATTEMPTS;
  const createIfMissing = options.createIfMissing ?? true;
  const busyWaitMs = options.busyWaitMs ?? 0;
  const sleep2 = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const busyDeadline = Date.now() + busyWaitMs;
  let lastConflict;
  let conflicts = 0;
  while (conflicts < maxAttempts) {
    const observedAt = now();
    const current = await port.readTask(task);
    if (!current && !createIfMissing) {
      throw new AuthorityStateNotFoundError(task);
    }
    if (current && !current.controllerState) {
      const compatibilityQuiescent = current.desiredIntentId === void 0 && current.intents.every(
        (intent) => ["completed", "superseded"].includes(intent.state)
      );
      throw new AuthorityStateMissingError(task, compatibilityQuiescent);
    }
    if (current?.lease && current.lease.owner !== owner && leaseIsLive(current.lease, observedAt)) {
      const remainingBudget = busyDeadline - Date.now();
      if (remainingBudget <= 0) {
        throw new TaskLeaseBusyError(task, current.lease);
      }
      const remainingLease = Date.parse(current.lease.expiresAt) - Date.parse(observedAt);
      await sleep2(
        Math.max(1, Math.min(1e3, remainingBudget, remainingLease))
      );
      continue;
    }
    const ledger = structuredClone(current?.controllerState ?? seed);
    const lease = {
      owner,
      acquiredAt: current?.lease?.owner === owner ? current.lease.acquiredAt : observedAt,
      expiresAt: new Date(Date.parse(observedAt) + leaseMs).toISOString()
    };
    try {
      const stored = await port.writeTask(
        task,
        current?.revision,
        { ...projectLedgerToStoredTask(ledger), lease },
        observedAt
      );
      return {
        ledger,
        session: { port, owner, revision: stored.revision, lease }
      };
    } catch (error) {
      if (!(error instanceof TaskWriteConflictError)) throw error;
      lastConflict = error;
      conflicts += 1;
    }
  }
  throw lastConflict;
}
async function persistAuthority(session, ledger, now = (/* @__PURE__ */ new Date()).toISOString()) {
  session.lease = {
    ...session.lease,
    expiresAt: new Date(Date.parse(now) + DEFAULT_TASK_LEASE_MS).toISOString()
  };
  const written = await session.port.writeTask(
    ledger.task,
    session.revision,
    { ...projectLedgerToStoredTask(ledger), lease: session.lease },
    now
  );
  session.revision = written.revision;
  return written;
}
async function releaseAuthority(session, ledger, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const written = await session.port.writeTask(
    ledger.task,
    session.revision,
    projectLedgerToStoredTask(ledger),
    now
  );
  session.revision = written.revision;
}

// apps/dispatch-broker/src/storage/firestore-rest-port.ts
import { isDeepStrictEqual as isDeepStrictEqual2 } from "node:util";
var TASKS_COLLECTION = "dispatchTasks";
var LAUNCH_OUTBOX_COLLECTION = "dispatchLaunchOutbox";
function defaultNow() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function sameResolution(a, b) {
  return isDeepStrictEqual2(a, b);
}
function toFirestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        // Defensive, not load-bearing for anything port.contract.ts
        // exercises today: no domain field here is ever an array
        // containing `undefined`, but skipping it (rather than crashing on
        // it) matches the same "absent, not null" posture `toFirestoreFields`
        // takes for object keys below.
        values: value.filter((element) => element !== void 0).map(toFirestoreValue)
      }
    };
  }
  if (typeof value === "object") {
    return {
      mapValue: {
        fields: toFirestoreFields(value)
      }
    };
  }
  throw new TypeError(
    `Cannot store a value of type ${typeof value} in Firestore`
  );
}
function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === void 0) continue;
    fields[key] = toFirestoreValue(value);
  }
  return fields;
}
function fromFirestoreValue(value) {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("stringValue" in value) return value.stringValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) {
    return (value.arrayValue.values ?? []).map(fromFirestoreValue);
  }
  if ("mapValue" in value) {
    return fromFirestoreFields(value.mapValue.fields ?? {});
  }
  throw new TypeError(`Unrecognized Firestore value: ${JSON.stringify(value)}`);
}
function fromFirestoreFields(fields) {
  const obj = {};
  for (const [key, value] of Object.entries(fields)) {
    obj[key] = fromFirestoreValue(value);
  }
  return obj;
}
var FirestoreRestError = class extends Error {
  constructor(status, body) {
    super(
      `Firestore REST request failed with HTTP ${status}: ${JSON.stringify(body)}`
    );
    this.status = status;
    this.body = body;
    this.name = "FirestoreRestError";
  }
  status;
  body;
};
var FirestoreRestStoragePort = class {
  #token;
  #documentsRoot;
  #baseUrl;
  constructor(options) {
    this.#token = options.token;
    this.#documentsRoot = `projects/${options.projectId}/databases/${options.databaseId}/documents`;
    const emulatorHost = options.emulatorHost ?? process.env.FIRESTORE_EMULATOR_HOST;
    this.#baseUrl = emulatorHost ? `http://${emulatorHost}/v1/${this.#documentsRoot}` : `https://firestore.googleapis.com/v1/${this.#documentsRoot}`;
  }
  async #authHeader() {
    const token = typeof this.#token === "function" ? await this.#token() : this.#token;
    return `Bearer ${token}`;
  }
  async #request(url, init) {
    const requestInit = {
      method: init?.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: await this.#authHeader()
      }
    };
    if (init?.body !== void 0) {
      requestInit.body = JSON.stringify(init.body);
    }
    const response = await fetch(url, requestInit);
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : void 0
    };
  }
  #documentUrl(collection, id) {
    return `${this.#baseUrl}/${collection}/${encodeURIComponent(id)}`;
  }
  #documentName(collection, id) {
    return `${this.#documentsRoot}/${collection}/${id}`;
  }
  /** `GET` one document. `undefined` when it does not exist -- the REST API
   *  reports that as HTTP 404 `NOT_FOUND`, verified directly against the
   *  emulator rather than assumed. */
  async #getDocument(collection, id) {
    const { status, body } = await this.#request(
      this.#documentUrl(collection, id)
    );
    if (status === 404) return void 0;
    if (status !== 200) throw new FirestoreRestError(status, body);
    const document = body;
    return { fields: document.fields ?? {}, updateTime: document.updateTime };
  }
  /**
   * `:commit` one document write under a `currentDocument` precondition.
   * Returns `false` -- never throws -- when the precondition was not met
   * (`ALREADY_EXISTS` for a failed `exists: false`, `FAILED_PRECONDITION`
   * for a stale `updateTime`), both verified directly against the emulator.
   * Any other non-2xx response is a genuine, unexpected failure and throws
   * `FirestoreRestError`.
   */
  async #commit(collection, id, fields, currentDocument) {
    const { status, body } = await this.#request(`${this.#baseUrl}:commit`, {
      method: "POST",
      body: {
        writes: [
          {
            update: { name: this.#documentName(collection, id), fields },
            currentDocument
          }
        ]
      }
    });
    if (status === 200) return true;
    const errorStatus = body?.error?.status;
    if (status === 409 && errorStatus === "ALREADY_EXISTS" || status === 400 && errorStatus === "FAILED_PRECONDITION") {
      return false;
    }
    throw new FirestoreRestError(status, body);
  }
  // -------------------------------------------------------------------------
  // Task aggregate.
  // -------------------------------------------------------------------------
  async readTask(task) {
    const document = await this.#getDocument(TASKS_COLLECTION, taskKey(task));
    return document ? fromFirestoreFields(document.fields) : void 0;
  }
  async writeTask(task, expectedRevision, next, now = defaultNow()) {
    const id = taskKey(task);
    const current = await this.#getDocument(TASKS_COLLECTION, id);
    const currentRevision = current ? fromFirestoreFields(current.fields).revision : void 0;
    if (currentRevision !== expectedRevision) {
      throw new TaskWriteConflictError(task, expectedRevision, currentRevision);
    }
    const stored = {
      ...structuredClone(next),
      task: structuredClone(task),
      revision: (expectedRevision ?? 0) + 1,
      updatedAt: now
    };
    const precondition = current ? { updateTime: current.updateTime } : { exists: false };
    const committed = await this.#commit(
      TASKS_COLLECTION,
      id,
      toFirestoreFields(stored),
      precondition
    );
    if (!committed) {
      const latest = await this.#getDocument(TASKS_COLLECTION, id);
      const latestRevision = latest ? fromFirestoreFields(latest.fields).revision : void 0;
      throw new TaskWriteConflictError(task, expectedRevision, latestRevision);
    }
    return stored;
  }
  // -------------------------------------------------------------------------
  // Launch outbox.
  // -------------------------------------------------------------------------
  async recordLaunchIntent(operation, now = defaultNow()) {
    const document = await this.#getDocument(
      LAUNCH_OUTBOX_COLLECTION,
      operation.operationId
    );
    if (document) {
      const existing = fromFirestoreFields(
        document.fields
      );
      const sameOperation = existing.attemptId === operation.attemptId && taskKey(existing.task) === taskKey(operation.task);
      if (!sameOperation) {
        throw new Error(
          `Launch outbox operation ID reused for a different attempt: ${operation.operationId}`
        );
      }
      return existing;
    }
    const created = {
      operationId: operation.operationId,
      task: structuredClone(operation.task),
      attemptId: operation.attemptId,
      recordedAt: now,
      status: "pending"
    };
    const committed = await this.#commit(
      LAUNCH_OUTBOX_COLLECTION,
      operation.operationId,
      toFirestoreFields(created),
      { exists: false }
    );
    if (!committed) {
      return this.recordLaunchIntent(operation, now);
    }
    return created;
  }
  async resolveLaunchOutcome(operationId, resolution, now = defaultNow()) {
    const document = await this.#getDocument(
      LAUNCH_OUTBOX_COLLECTION,
      operationId
    );
    if (!document) {
      throw new Error(
        `Cannot resolve launch outbox operation that was never recorded: ${operationId}`
      );
    }
    const existing = fromFirestoreFields(
      document.fields
    );
    if (existing.status !== "pending") {
      if (existing.resolution && sameResolution(existing.resolution, resolution)) {
        return existing;
      }
      throw new Error(
        `Launch outbox operation ${operationId} already resolved as ${existing.status}; refusing to overwrite with a different resolution`
      );
    }
    const resolved = {
      ...existing,
      status: resolution.status,
      resolvedAt: now,
      resolution
    };
    const committed = await this.#commit(
      LAUNCH_OUTBOX_COLLECTION,
      operationId,
      toFirestoreFields(resolved),
      { updateTime: document.updateTime }
    );
    if (!committed) {
      return this.resolveLaunchOutcome(operationId, resolution, now);
    }
    return resolved;
  }
  async readLaunchOperation(operationId) {
    const document = await this.#getDocument(
      LAUNCH_OUTBOX_COLLECTION,
      operationId
    );
    return document ? fromFirestoreFields(
      document.fields
    ) : void 0;
  }
  async listPendingLaunchOperations() {
    const { status, body } = await this.#request(`${this.#baseUrl}:runQuery`, {
      method: "POST",
      body: {
        structuredQuery: {
          from: [{ collectionId: LAUNCH_OUTBOX_COLLECTION }],
          where: {
            fieldFilter: {
              field: { fieldPath: "status" },
              op: "EQUAL",
              value: { stringValue: "pending" }
            }
          }
        }
      }
    });
    if (status !== 200) throw new FirestoreRestError(status, body);
    const rows = body;
    return rows.filter((row) => row.document !== void 0).map(
      (row) => fromFirestoreFields(
        row.document?.fields ?? {}
      )
    );
  }
};

// apps/dispatch-broker/src/main.ts
function env(name, required = true) {
  const value = process.env[name];
  if (required && !value) throw new Error(`${name} is required`);
  return value ?? "";
}
function output(name, value) {
  const path = env("GITHUB_OUTPUT");
  return fs.appendFile(path, `${name}=${value}
`, "utf8");
}
function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decode(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}
function api() {
  return createGitHubApi({ token: env("GITHUB_TOKEN") });
}
function createStoragePort() {
  return new FirestoreRestStoragePort({
    projectId: env("GCP_PROJECT_ID"),
    databaseId: env("DISPATCH_FIRESTORE_DATABASE_ID"),
    token: env("DISPATCH_STORAGE_TOKEN")
  });
}
async function saveLedger2(client, loaded) {
  if (!loaded.authority) {
    await saveLedger(client, loaded);
    return;
  }
  if (loaded.projectionAvailable === false) {
    recordProjectionStatus(loaded.ledger, false);
    await persistAuthority(loaded.authority, loaded.ledger);
    return;
  }
  await persistAuthority(loaded.authority, loaded.ledger);
  try {
    await saveLedger(client, loaded);
  } catch (error) {
    loaded.projectionAvailable = false;
    recordProjectionStatus(loaded.ledger, false);
    await persistAuthority(loaded.authority, loaded.ledger);
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `::warning::Dispatch state committed to Firestore, but its GitHub ledger projection failed: ${message}`
    );
  }
}
async function saveProjectionCheckpoint(client, loaded) {
  if (!loaded.authority) {
    recordProjectionStatus(loaded.ledger, true);
    await saveLedger2(client, loaded);
    return;
  }
  if (loaded.projectionAvailable === false) {
    recordProjectionStatus(loaded.ledger, false);
    await persistAuthority(loaded.authority, loaded.ledger);
    return;
  }
  const beforeProjection = loaded.ledger;
  const converged = structuredClone(beforeProjection);
  recordProjectionStatus(converged, true);
  loaded.ledger = converged;
  try {
    await saveLedger(client, loaded);
  } catch (error) {
    loaded.ledger = beforeProjection;
    recordProjectionStatus(loaded.ledger, false);
    await persistAuthority(loaded.authority, loaded.ledger);
    throw error;
  }
  await persistAuthority(loaded.authority, loaded.ledger);
}
function contextFor(event, inputs) {
  return {
    repository: event.repository?.full_name ?? env("GITHUB_REPOSITORY"),
    repositoryId: event.repository?.id ?? Number(env("GITHUB_REPOSITORY_ID")),
    issue: inputs.issue,
    runId: Number(env("GITHUB_RUN_ID")),
    actor: env("GITHUB_ACTOR"),
    now: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function runPhase(ledgerContext, phase, step, owningSystem = "controller") {
  try {
    return await step();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = classifyFailure({
      phase,
      owningSystem,
      reason: "internal_error",
      retryDisposition: "manual",
      detail: message
    });
    console.log(`::error::${formatFailure(failure)}: ${message}`);
    if (ledgerContext) {
      try {
        addAnomaly(
          ledgerContext.loaded.ledger,
          "phase-failure",
          { phase, message },
          void 0,
          failure
        );
        await saveLedger2(ledgerContext.client, ledgerContext.loaded);
      } catch (recordingError) {
        const recordingMessage = recordingError instanceof Error ? recordingError.message : String(recordingError);
        console.log(
          `::error::Failed to record the above ${phase} phase failure to the dispatch ledger: ${recordingMessage}`
        );
      }
    }
    throw error;
  }
}
async function normalize() {
  const event = JSON.parse(
    await fs.readFile(
      /* turbopackIgnore: true */
      env("GITHUB_EVENT_PATH"),
      "utf8"
    )
  );
  const eventName = env("GITHUB_EVENT_NAME");
  const inputs = event.inputs ?? {};
  const context = contextFor(event, inputs);
  const client = api();
  if (eventName === "workflow_dispatch") {
    const issue2 = await client.requestOk(
      `${repositoryPath({ repository: context.repository })}/issues/${inputs.issue}`
    );
    event.issue = issue2;
  }
  let timeline = [];
  const wantsTimeline = eventName === "issues" && ["labeled", "unlabeled", "closed", "reopened"].includes(event.action) || ["pull_request", "pull_request_target"].includes(eventName) && ["labeled", "unlabeled"].includes(event.action);
  if (wantsTimeline) {
    const numbered = event.issue ?? event.pull_request;
    if (!numbered) {
      throw new Error(
        `Event ${eventName}/${event.action} claimed a timeline but carried neither issue nor pull_request`
      );
    }
    timeline = await client.requestOk(
      `${repositoryPath({ repository: context.repository })}/issues/${numbered.number}/timeline?per_page=100`
    );
  }
  const normalized = await runPhase(
    void 0,
    "signal",
    () => normalizeEvent({
      eventName,
      event,
      inputs,
      context,
      timeline,
      maintainer: env("MAINTAINER_LOGIN")
    })
  );
  const normalizedTask = "task" in normalized ? normalized.task : void 0;
  const normalizedReason = "reason" in normalized ? normalized.reason : void 0;
  const issue = normalizedTask?.issue ?? event.issue?.number ?? Number(inputs.issue);
  await output("eligible", normalized.kind === "ignored" ? "false" : "true");
  await output("issue", String(issue || ""));
  await output("repository-id", String(context.repositoryId));
  await output(
    "is-pr",
    String(Boolean(event.pull_request ?? event.issue?.pull_request))
  );
  await output(
    "group",
    issue ? `agent-lcars-dispatch-v1-${context.repositoryId}-${issue}`.toLowerCase() : ""
  );
  await output("payload", encode(normalized));
  await output("reason", normalizedReason ?? "");
}
function activeGeneration(ledger) {
  return ledger.generations.find(
    (generation) => ACTIVE_STATES.has(generation.state)
  );
}
function assertWorkerRun(run, task, generation, expectedWorkflow) {
  if (run.repository?.id !== task.repositoryId || run.event !== "workflow_dispatch" || run.path !== `.github/workflows/${expectedWorkflow}` || !displayTitleMatchesAttempt(run.display_title, generation)) {
    throw new Error("Worker run identity does not match its ledger binding");
  }
}
async function reconcileActive(client, loaded, now = (/* @__PURE__ */ new Date()).toISOString(), maintainer = "") {
  let active = activeGeneration(loaded.ledger);
  if (!active) return;
  const expectedWorkflow = workerWorkflow(active.pipeline);
  const matchingRuns = await findRunsForGeneration(
    client,
    loaded.ledger.task,
    active
  );
  if (matchingRuns.length > 1) {
    addAnomaly(
      loaded.ledger,
      "duplicate-attempt",
      {
        generation: active.generation,
        runIds: matchingRuns.map((run2) => run2.id)
      },
      void 0,
      // The reconciler is what noticed this, but the state that is wrong --
      // "at most one worker run bound to a generation" -- is the ledger's
      // own invariant, so the controller (its state authority) owns it, not
      // whichever of the two GitHub Actions runs happens to be the
      // duplicate. No reason code in the vocabulary names "two runs matched
      // one generation" specifically (#645's audit table never hit this
      // case), so this falls back to `internal_error`, the vocabulary's own
      // catch-all for exactly that gap. `never`, not `manual`: re-running
      // the broker on the next event re-derives the same duplicate-run
      // snapshot and throws again -- retrying cannot resolve it, and
      // dispatching a fresh attempt to "fix" it would only add a third
      // duplicate. Only a human fixing the underlying divergence (cancel a
      // run, or correct the ledger) out of band lets the next reconcile
      // pass see a clean state again.
      classifyFailure({
        phase: "reconciliation",
        owningSystem: "controller",
        reason: "internal_error",
        retryDisposition: "never"
      })
    );
    await saveLedger2(client, loaded);
    throw new Error("Multiple worker runs match one dispatch generation");
  }
  if (["dispatching", "dispatch-unknown"].includes(active.state) && matchingRuns.length === 1) {
    const run2 = matchingRuns[0];
    assertWorkerRun(run2, loaded.ledger.task, active, expectedWorkflow);
    bindRun(loaded.ledger, active.generation, {
      runId: run2.id,
      runUrl: run2.url,
      htmlUrl: run2.html_url,
      workflow: expectedWorkflow
    });
    await saveLedger2(client, loaded);
    active = activeGeneration(loaded.ledger);
  }
  if (!active?.attempt?.runId) return;
  const run = await getWorkflowRun(
    client,
    loaded.ledger.task,
    active.attempt.runId
  );
  assertWorkerRun(run, loaded.ledger.task, active, expectedWorkflow);
  await resolvePendingLaunchAsLaunchedBestEffort(loaded, active, {
    runId: run.id,
    runUrl: run.url,
    htmlUrl: run.html_url
  });
  if (run.status === "completed") {
    completeRun(loaded.ledger, active.generation, {
      runId: run.id,
      status: run.status,
      conclusion: run.conclusion,
      completedAt: run.updated_at
    });
    await saveLedger2(client, loaded);
    return;
  }
  await trackStuckRun(client, loaded, active, run, now, maintainer);
}
var RECONCILE_MISSING_RUN_GRACE_MS = 5 * 60 * 1e3;
var RECONCILE_MISSING_RUN_MIN_INTERVAL_MS = 5 * 60 * 1e3;
var RECONCILE_MISSING_RUN_MAX_ATTEMPTS = 3;
var CLOSED_ANCHOR_LAUNCH_REJECTION = "anchor closed before launch was observed";
function reconcileAnomaliesFor(ledger, generationNumber, kind) {
  return ledger.anomalies.filter(
    (anomaly) => anomaly.kind === kind && // `detail` is deliberately untyped on LedgerAnomaly (each kind owns
    // its own shape) -- every `addAnomaly` call below that records one of
    // these two kinds always includes a numeric `generation` field.
    anomaly.detail?.generation === generationNumber
  );
}
async function readLaunchOperationForReconciliation(loaded, attemptId) {
  if (!loaded.authority) return { ok: true, operation: void 0 };
  try {
    return {
      ok: true,
      operation: await loaded.authority.port.readLaunchOperation(attemptId)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `::warning::Deferring launch reconciliation for ${attemptId} until its outbox record can be read: ${message}`
    );
    return { ok: false };
  }
}
async function trackMissingRun(client, loaded, generation, now, maintainer) {
  const ledger = loaded.ledger;
  if (reconcileAnomaliesFor(ledger, generation.generation, "reconcile-parked").length > 0) {
    return;
  }
  const startedAt = Date.parse(
    generation.attempt?.dispatchStartedAt ?? generation.occurredAt
  );
  const ageMs = Date.parse(now) - startedAt;
  if (!(ageMs >= RECONCILE_MISSING_RUN_GRACE_MS)) return;
  const priorObservations = reconcileAnomaliesFor(
    ledger,
    generation.generation,
    "reconcile-missing-run"
  );
  const last = priorObservations.at(-1);
  if (last && Date.parse(now) - Date.parse(last.occurredAt) < RECONCILE_MISSING_RUN_MIN_INTERVAL_MS) {
    return;
  }
  const attempt = priorObservations.length + 1;
  const reachedBound = attempt >= RECONCILE_MISSING_RUN_MAX_ATTEMPTS;
  const attemptId = generation.attempt?.attemptId ?? formatAttemptId(generation);
  const launchRead = reachedBound && loaded.authority ? await readLaunchOperationForReconciliation(loaded, attemptId) : { ok: true, operation: void 0 };
  if (!launchRead.ok) return;
  const launchOperation = launchRead.operation;
  const retryPendingLaunch = Boolean(
    !ledger.control.closed && launchOperation?.status === "pending" && launchOperation.operationId === attemptId && launchOperation.attemptId === attemptId
  );
  const abandonClosedLaunch = Boolean(
    ledger.control.closed && launchOperation?.operationId === attemptId && launchOperation.attemptId === attemptId && (launchOperation.status === "pending" || launchOperation.resolution?.status === "rejected" && launchOperation.resolution.reason === CLOSED_ANCHOR_LAUNCH_REJECTION)
  );
  const parkFailure = reachedBound && !retryPendingLaunch && !abandonClosedLaunch ? classifyFailure({
    phase: "reconciliation",
    owningSystem: "controller",
    reason: "launch_response_lost",
    retryDisposition: "manual",
    evidence: `${RECONCILE_MISSING_RUN_MAX_ATTEMPTS} bounded reconcile-missing-run observations exhausted for generation ${generation.generation}`
  }) : void 0;
  if (abandonClosedLaunch && launchOperation?.status === "pending") {
    try {
      await loaded.authority?.port.resolveLaunchOutcome(attemptId, {
        status: "rejected",
        reason: CLOSED_ANCHOR_LAUNCH_REJECTION
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        `::warning::Deferring closed-anchor launch abandonment for ${attemptId} until its outbox record can be resolved: ${message}`
      );
      return;
    }
  }
  if (parkFailure) {
    await projectNeedsHumanPark(client, ledger.task, maintainer, parkFailure);
  }
  addAnomaly(
    ledger,
    "reconcile-missing-run",
    {
      generation: generation.generation,
      intentId: generation.intentId,
      pipeline: generation.pipeline,
      state: generation.state,
      attempt,
      ageMs
    },
    now,
    // A `dispatching`/`dispatch-unknown` generation with no bound run after
    // its grace period is the delayed confirmation of exactly what
    // `dispatch-unknown`/`markDispatchUnknown` already names: the
    // controller does not know whether its own dispatch POST landed. That
    // makes the controller the owning system even though one of the two
    // root causes #305's audit named (a worker crashing before ever
    // registering) is technically a worker failure -- the ledger state
    // being reconciled here is the controller's own bookkeeping, and the
    // reconciler cannot distinguish the two causes from a bare zero-match
    // observation. `backoff`, not `manual`: this is still inside the
    // bounded-retry window (`RECONCILE_MISSING_RUN_MAX_ATTEMPTS`) --
    // trackMissingRun's own next scheduled pass, at least
    // `RECONCILE_MISSING_RUN_MIN_INTERVAL_MS` later, is the retry, and
    // `retryBudget` mirrors the attempts this same counter has left before
    // `reconcile-parked` (below) takes over.
    classifyFailure({
      phase: "reconciliation",
      owningSystem: "controller",
      reason: "launch_response_lost",
      retryDisposition: "backoff",
      retryBudget: Math.max(0, RECONCILE_MISSING_RUN_MAX_ATTEMPTS - attempt),
      evidence: `no worker run bound to generation ${generation.generation} ${ageMs}ms after dispatch (observation ${attempt}/${RECONCILE_MISSING_RUN_MAX_ATTEMPTS})`
    })
  );
  if (retryPendingLaunch) {
    addAnomaly(
      ledger,
      "reconcile-launch-retry",
      {
        generation: generation.generation,
        intentId: generation.intentId,
        operationId: attemptId,
        reason: "pending-launch-outbox-bound-exhausted"
      },
      now,
      classifyFailure({
        phase: "reconciliation",
        owningSystem: "controller",
        reason: "launch_response_lost",
        retryDisposition: "immediate",
        retryBudget: 1,
        evidence: `the exact launch outbox operation ${attemptId} is still pending after ${RECONCILE_MISSING_RUN_MAX_ATTEMPTS} bounded searches found no matching workflow run`
      })
    );
    restoreAcceptedForLaunchRetry(ledger, generation.generation, now);
    await saveLedger2(client, loaded);
    return;
  }
  if (abandonClosedLaunch) {
    addAnomaly(
      ledger,
      "reconcile-launch-abandoned",
      {
        generation: generation.generation,
        intentId: generation.intentId,
        operationId: attemptId,
        reason: "anchor-closed-before-launch-observed"
      },
      now
    );
    abandonPendingLaunchForClosedAnchor(
      ledger,
      generation.generation,
      CLOSED_ANCHOR_LAUNCH_REJECTION,
      now
    );
    await saveLedger2(client, loaded);
    return;
  }
  if (parkFailure) {
    addAnomaly(
      ledger,
      "reconcile-parked",
      {
        generation: generation.generation,
        reason: "missing-run-bound-exhausted"
      },
      now,
      // The genuine human handoff: `projectNeedsHumanPark` (above) has
      // just run, and the guard at the top of this function turns every
      // later pass into a no-op, so nothing further happens automatically.
      parkFailure
    );
  }
  await saveLedger2(client, loaded);
}
var RECONCILE_STUCK_RUN_GRACE_MS = 4 * 60 * 60 * 1e3;
var RECONCILE_STUCK_RUN_MIN_INTERVAL_MS = 30 * 60 * 1e3;
var RECONCILE_STUCK_RUN_MAX_ATTEMPTS = 3;
async function trackStuckRun(client, loaded, generation, run, now, maintainer) {
  const ledger = loaded.ledger;
  if (reconcileAnomaliesFor(
    ledger,
    generation.generation,
    "reconcile-stuck-run-parked"
  ).length > 0) {
    return;
  }
  const boundAt = Date.parse(
    generation.attempt?.boundAt ?? generation.attempt?.dispatchStartedAt ?? generation.occurredAt
  );
  const ageMs = Date.parse(now) - boundAt;
  if (!(ageMs >= RECONCILE_STUCK_RUN_GRACE_MS)) return;
  const priorObservations = reconcileAnomaliesFor(
    ledger,
    generation.generation,
    "reconcile-stuck-run"
  );
  const last = priorObservations.at(-1);
  if (last && Date.parse(now) - Date.parse(last.occurredAt) < RECONCILE_STUCK_RUN_MIN_INTERVAL_MS) {
    return;
  }
  const attempt = priorObservations.length + 1;
  const reachedBound = attempt >= RECONCILE_STUCK_RUN_MAX_ATTEMPTS;
  const parkFailure = reachedBound ? classifyFailure({
    phase: "reconciliation",
    owningSystem: "runner",
    reason: "runner_lost",
    retryDisposition: "manual",
    evidence: `${RECONCILE_STUCK_RUN_MAX_ATTEMPTS} bounded reconcile-stuck-run observations exhausted for generation ${generation.generation}; worker run ${run.id} still reports status "${run.status}"`
  }) : void 0;
  if (parkFailure) {
    await projectNeedsHumanPark(client, ledger.task, maintainer, parkFailure);
  }
  addAnomaly(
    ledger,
    "reconcile-stuck-run",
    {
      generation: generation.generation,
      intentId: generation.intentId,
      pipeline: generation.pipeline,
      state: generation.state,
      runId: run.id,
      status: run.status,
      attempt,
      ageMs
    },
    now,
    // owningSystem: 'runner', not 'controller' -- this reconciler is what
    // NOTICED the stall, but the state that is wrong ("a dispatched run
    // makes progress and eventually reports terminal") is the runner's own
    // execution and reporting, not the controller's ledger bookkeeping. A
    // hung self-hosted runner is squarely the runner's failure even though
    // the controller is the one running this check; `runner_lost` is the
    // vocabulary's own name for exactly "the runner disappeared/stopped
    // reporting". `backoff`, not `manual`: this is still inside the bounded
    // observation window (RECONCILE_STUCK_RUN_MAX_ATTEMPTS) -- the next
    // scheduled reconcile pass, at least RECONCILE_STUCK_RUN_MIN_INTERVAL_MS
    // later, is that retry, and `retryBudget` mirrors the observations this
    // same counter has left before `reconcile-stuck-run-parked` (below)
    // takes over.
    classifyFailure({
      phase: "reconciliation",
      owningSystem: "runner",
      reason: "runner_lost",
      retryDisposition: "backoff",
      retryBudget: Math.max(0, RECONCILE_STUCK_RUN_MAX_ATTEMPTS - attempt),
      evidence: `worker run ${run.id} still reports status "${run.status}" ${ageMs}ms after binding, past the longest legitimate run's own grace period (observation ${attempt}/${RECONCILE_STUCK_RUN_MAX_ATTEMPTS})`
    })
  );
  if (parkFailure) {
    addAnomaly(
      ledger,
      // Distinct kind from trackMissingRun's own 'reconcile-parked' so the
      // two orphan classes stay distinguishable in the ledger even once
      // both are parked -- a missing-run park never got a bound run at all,
      // a stuck-run park got one that then stopped making progress, and an
      // operator reading the anomaly list should not have to open `detail`
      // to tell which happened.
      "reconcile-stuck-run-parked",
      {
        generation: generation.generation,
        reason: "stuck-run-bound-exhausted"
      },
      now,
      // The genuine human handoff: `projectNeedsHumanPark` (above) has
      // just run, and the guard at the top of this function turns every
      // later pass into a no-op, so nothing further happens automatically.
      parkFailure
    );
  }
  await saveLedger2(client, loaded);
}
async function repairMissingIntentFromLabel(client, loaded, now, runId, maintainer = "") {
  const ledger = loaded.ledger;
  const task = ledger.task;
  const root = repositoryPath(task);
  const issue = await client.requestOk(
    `${root}/issues/${task.issue}`
  );
  let pipeline = selectedPipeline(issue);
  let mode = "implement";
  let labelName = pipeline && `agent:${pipeline}`;
  if (!pipeline && issue.pull_request) {
    const issueLabels = (issue.labels ?? []).map(
      (label) => typeof label === "string" ? label : label.name
    );
    pipeline = selectedPipelineFrom(issueLabels, REVIEW_LABELS);
    mode = "review";
    labelName = pipeline && `review:${pipeline}`;
  }
  if (!pipeline) return;
  const timeline = await listAll(
    client,
    `${root}/issues/${task.issue}/timeline`
  );
  const labelApplications = timeline.filter(
    (event) => event.event === "labeled" && event.label?.name === labelName
  ).sort(
    (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)
  );
  const mostRecent = labelApplications[0];
  let actor;
  let authorizationRule = "reconcile-label-repair";
  let quickTask;
  let sourceKind;
  let sourceId;
  let occurredAt;
  if (mostRecent) {
    if (!Number.isSafeInteger(mostRecent.id)) return;
    sourceKind = "labeled";
    sourceId = `timeline:${mostRecent.id}`;
    occurredAt = mostRecent.created_at;
    if (ledger.sources.some(
      (source) => source.sourceKind === sourceKind && source.sourceId === sourceId
    )) {
      return;
    }
    const legacySource = ledger.sources.find(
      (source) => source.sourceKind === "reconcile-label-repair" && source.sourceId === `reconcile-label-repair:${issue.id}`
    );
    const legacyGeneration = ledger.generations.find(
      (generation) => generation.intentId === legacySource?.intentId
    );
    if (legacySource && legacyGeneration?.pipeline === pipeline && legacyGeneration.mode === mode && Date.parse(legacySource.occurredAt) >= Date.parse(occurredAt)) {
      return;
    }
    actor = mostRecent.actor;
    if (!actor || actor.login !== maintainer) return;
    quickTask = quickTaskRequest(issue, task.repository, pipeline);
  } else {
    actor = issue.user;
    if (!actor || actor.login !== maintainer) return;
    sourceKind = "opened";
    sourceId = `issue:${issue.id}`;
    occurredAt = issue.created_at;
    if (ledger.sources.some(
      (source) => source.sourceKind === sourceKind && source.sourceId === sourceId
    )) {
      return;
    }
    quickTask = quickTaskRequest(issue, task.repository, pipeline);
    if (!quickTask) return;
    authorizationRule = "reconcile-quick-task-create-repair";
  }
  const intent = makeIntent({
    task,
    ...quickTask && {
      intentId: `quick:${quickTask.requestId}:${quickTask.digest}`
    },
    sourceKind,
    sourceId,
    transportRunId: runId,
    occurredAt,
    pipeline,
    mode,
    reply: "",
    runbook: "",
    context: "",
    authorization: {
      authorized: true,
      // mostRecent.actor is proven defined by the guard just above: if it
      // were undefined, `mostRecent.actor?.login` would be `undefined`,
      // which cannot equal `maintainer` there without already returning.
      actor: actor.login,
      configuredMaintainer: maintainer,
      rule: authorizationRule
    }
  });
  acceptIntent(ledger, intent, now);
  await saveLedger2(client, loaded);
}
async function reconcileControlState(client, loaded, issueClosed, now, runId) {
  const ledger = loaded.ledger;
  if (issueClosed === void 0) return ledger.control.closed;
  if (issueClosed !== ledger.control.closed) {
    applyAnchorControl(
      ledger,
      {
        kind: issueClosed ? "closed" : "reopened",
        sourceId: `reconcile-control:${ledger.task.issue}:${issueClosed ? "closed" : "reopened"}:${now}`,
        occurredAt: now,
        transportRunId: runId,
        authorization: { observed: true, actor: "dispatch-broker" },
        // A reconcile pass only carries the issue's own open/closed state
        // (see ReconcileEvent/`issueClosed` in normalize.mjs), not the
        // richer merge signal a live `issues`/`pull_request` webhook
        // payload carries -- unlike control.closed, nothing reads
        // control.merged today (grep finds only its two writers), so
        // recording it as unknown-here rather than threading a second
        // field through purely to populate descriptive metadata is a
        // deliberate simplification, not an oversight.
        merged: false
      },
      now
    );
    await saveLedger2(client, loaded);
  }
  return issueClosed;
}
async function reconcileLedger(client, loaded, now = (/* @__PURE__ */ new Date()).toISOString(), runId, issueClosed, maintainer = "") {
  const ledger = loaded.ledger;
  const anchorClosed = await reconcileControlState(
    client,
    loaded,
    issueClosed,
    now,
    runId
  );
  if (anchorClosed) {
    const active2 = activeGeneration(ledger);
    const attemptId = active2?.attempt?.attemptId;
    if (loaded.authority && active2 && attemptId && ["dispatching", "dispatch-unknown"].includes(active2.state) && !active2.attempt?.runId) {
      const launchRead = await readLaunchOperationForReconciliation(
        loaded,
        attemptId
      );
      if (!launchRead.ok) return;
      const operation = launchRead.operation;
      if (operation?.operationId === attemptId && operation.attemptId === attemptId && (operation.status === "pending" || operation.resolution?.status === "rejected" && operation.resolution.reason === CLOSED_ANCHOR_LAUNCH_REJECTION)) {
        await trackMissingRun(client, loaded, active2, now, maintainer);
      }
    }
    return;
  }
  if (ledger.generations.length === 0 || !activeGeneration(ledger)) {
    await repairMissingIntentFromLabel(client, loaded, now, runId, maintainer);
  }
  if (ledger.generations.length === 0) return;
  const active = activeGeneration(ledger);
  const pending = ledger.generations.find(
    (candidate) => candidate.state === "pending"
  );
  if (pending && !active && reconcileAnomaliesFor(
    ledger,
    pending.generation,
    "reconcile-invariant-violation"
  ).length === 0) {
    const parkFailure = classifyFailure({
      phase: "reconciliation",
      owningSystem: "controller",
      reason: "internal_error",
      retryDisposition: "manual"
    });
    await projectNeedsHumanPark(client, ledger.task, maintainer, parkFailure);
    addAnomaly(
      ledger,
      "reconcile-invariant-violation",
      {
        detail: "pending generation with no contemporaneous active generation",
        generation: pending.generation
      },
      now,
      parkFailure
    );
    await saveLedger2(client, loaded);
    return;
  }
  if (!active || !["dispatching", "dispatch-unknown"].includes(active.state)) {
    return;
  }
  if (active.attempt?.runId) return;
  await trackMissingRun(client, loaded, active, now, maintainer);
}
async function dispatchReconcileScan2(client, repository, issueNumbers) {
  return dispatchReconcileScan(
    createReconcileTransport(client),
    repository,
    issueNumbers
  );
}
function isDefiniteDispatchRejection(error) {
  return error instanceof GitHubApiError && Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status);
}
async function resolveLaunchOutcomeBestEffort(loaded, generation, resolution) {
  if (!loaded.authority) return;
  const attemptId = generation.attempt?.attemptId ?? formatAttemptId(generation);
  try {
    await loaded.authority.port.resolveLaunchOutcome(attemptId, resolution);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `::warning::Primary dispatch state was persisted, but launch-outbox resolution for ${attemptId} will need reconciliation: ${message}`
    );
  }
}
async function resolvePendingLaunchAsLaunchedBestEffort(loaded, generation, binding) {
  if (!loaded.authority) return;
  const attemptId = generation.attempt?.attemptId ?? formatAttemptId(generation);
  try {
    const operation = await loaded.authority.port.readLaunchOperation(attemptId);
    if (operation?.status !== "pending") return;
    await loaded.authority.port.resolveLaunchOutcome(attemptId, {
      status: "launched",
      binding
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `::warning::Reconciliation confirmed workflow run ${binding.runId}, but launch-outbox resolution for ${attemptId} will need another pass: ${message}`
    );
  }
}
function issueHasNeedsHumanLabel(issue) {
  return (issue.labels ?? []).some(
    (label) => typeof label === "string" ? label === "status:needs-human" : label.name === "status:needs-human"
  );
}
async function anchorNeedsHuman(client, task) {
  const issue = await client.requestOk(
    `${repositoryPath(task)}/issues/${task.issue}`
  );
  return issueHasNeedsHumanLabel(issue);
}
async function holdForLaneReadiness(client, loaded, generation) {
  const blockers = await readLaneReadiness(
    client,
    loaded.ledger.task,
    generation.pipeline
  );
  if (blockers.length === 0) return false;
  const display = generation.pipeline[0].toUpperCase() + generation.pipeline.slice(1);
  await projectComment(
    client,
    loaded.ledger.task,
    "lane-readiness",
    generation.pipeline,
    (marker) => `${marker}

### ${display} dispatch paused for lane readiness

The broker held generation ${generation.generation} **before worker allocation** because the following durable health signal${blockers.length === 1 ? " is" : "s are"} open:

${blockers.map((blocker) => `- [#${blocker.issue}: ${blocker.title}](${blocker.url})`).join("\n")}

This is an automatic infrastructure hold, not a human-owned task park. Repair the linked health incident and close it (or let its canary close it on recovery). Scheduled reconcile will retry the readiness check and resume this accepted generation; do not create another dispatch generation. This notice is live only while a linked health issue remains open.`
  );
  console.log(
    `::notice::Holding accepted ${generation.pipeline} generation ${generation.generation} for issue #${loaded.ledger.task.issue} before worker allocation: readiness blocker${blockers.length === 1 ? "" : "s"} ` + blockers.map((blocker) => `#${blocker.issue}`).join(", ")
  );
  return true;
}
async function dispatchAccepted(client, loaded) {
  while (!loaded.ledger.control.closed) {
    const generation = loaded.ledger.generations.find(
      (candidate) => candidate.state === "accepted"
    );
    if (!generation || activeGeneration(loaded.ledger)) return;
    if (generation.pipeline !== "canary" && await anchorNeedsHuman(client, loaded.ledger.task)) {
      console.log(
        `::notice::Holding accepted generation ${generation.generation} for issue #${loaded.ledger.task.issue}: status:needs-human is present. Remove the label to resume through the ordinary serialized broker path.`
      );
      return;
    }
    if (await holdForLaneReadiness(client, loaded, generation)) return;
    const beforeScheduling = structuredClone(loaded.ledger);
    const scheduled = await runPhase(
      { client, loaded },
      "scheduling",
      async () => {
        beginDispatch(
          loaded.ledger,
          generation.generation,
          crypto3.randomBytes(24).toString("base64url")
        );
        if (loaded.authority) {
          const attemptId = generation.attempt?.attemptId ?? formatAttemptId(generation);
          try {
            await loaded.authority.port.recordLaunchIntent({
              operationId: attemptId,
              task: loaded.ledger.task,
              attemptId
            });
          } catch (error) {
            loaded.ledger = beforeScheduling;
            const message = error instanceof Error ? error.message : String(error);
            console.log(
              `::warning::Deferring worker dispatch after launch-outbox recording failed: ${message}`
            );
            return false;
          }
        }
        await saveLedger2(client, loaded);
        return true;
      }
    );
    if (!scheduled) return;
    let binding;
    try {
      binding = await dispatchWorker(client, generation, loaded.ledger.task);
    } catch (error) {
      if (isDefiniteDispatchRejection(error)) {
        await runPhase({ client, loaded }, "launch", async () => {
          markDispatchRejected(
            loaded.ledger,
            generation.generation,
            `HTTP ${error.status}`
          );
          await saveLedger2(client, loaded);
          await resolveLaunchOutcomeBestEffort(loaded, generation, {
            status: "rejected",
            reason: `HTTP ${error.status}`
          });
          throw error;
        });
      }
      markDispatchUnknown(
        loaded.ledger,
        generation.generation,
        // Assumed Error-shaped, exactly as the untyped original assumed.
        error.message.slice(0, 300)
      );
      await saveLedger2(client, loaded);
      await resolveLaunchOutcomeBestEffort(loaded, generation, {
        status: "unknown",
        reason: error.message.slice(0, 300)
      });
      return;
    }
    bindRun(loaded.ledger, generation.generation, binding);
    await saveLedger2(client, loaded);
    await resolveLaunchOutcomeBestEffort(loaded, generation, {
      status: "launched",
      binding
    });
    return;
  }
}
var CompletionBindingError = class extends Error {
};
function completionLedgerMatches(generation, normalized) {
  return generation && generation.intentId === normalized.intentId && generation.attempt?.token === normalized.token && generation.attempt?.runId === normalized.workerRunId && normalized.workflow === workerWorkflow(generation.pipeline);
}
function assertCompletionLedgerBinding(ledger, normalized) {
  const generation = ledger.generations.find(
    (candidate) => candidate.generation === normalized.generation
  );
  if (!generation || !completionLedgerMatches(generation, normalized)) {
    throw new CompletionBindingError(
      "Completion callback does not match the bound worker run"
    );
  }
  return generation;
}
async function assertCompletionBindingBeforeInitialization(client, task, normalized, storageMode, storagePortFactory) {
  const ledger = storageMode === "authority" ? (await storagePortFactory().readTask(task))?.controllerState : (await loadLedger(client, task, void 0, {
    createIfMissing: false
  }))?.ledger;
  if (!ledger) {
    throw new CompletionBindingError(
      "Completion callback does not match the bound worker run"
    );
  }
  assertCompletionLedgerBinding(ledger, normalized);
}
function completionMatches(generation, normalized, run) {
  return completionLedgerMatches(generation, normalized) && run.id === normalized.workerRunId;
}
async function handleCompletion(client, loaded, normalized, polling = {}) {
  const now = polling.now ?? Date.now;
  const sleep2 = polling.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const generation = loaded.ledger.generations.find(
    (candidate) => candidate.generation === normalized.generation
  );
  let run = await getWorkflowRun(
    client,
    normalized.task,
    normalized.workerRunId
  );
  const expectedWorkflow = workerWorkflow(
    generation?.pipeline
  );
  assertWorkerRun(
    run,
    normalized.task,
    generation,
    expectedWorkflow
  );
  if (!generation) {
    throw new Error(`Generation ${normalized.generation} not found`);
  }
  if (normalized.workflow !== expectedWorkflow || !completionMatches(generation, normalized, run)) {
    throw new Error("Completion callback does not match the bound worker run");
  }
  const evidence = recordControlEvidence(loaded.ledger, {
    sourceKind: "completion",
    sourceId: normalized.sourceId,
    transportRunId: normalized.transportRunId,
    occurredAt: (/* @__PURE__ */ new Date()).toISOString(),
    runId: normalized.workerRunId,
    authorization: { observed: true, workflow: expectedWorkflow }
  });
  const priorOutcome = generation.attempt?.outcome;
  const priorOutcomeReference = generation.attempt?.outcomeReference;
  if (normalized.outcome) {
    recordOutcome(
      loaded.ledger,
      generation.generation,
      normalized.outcome,
      normalized.outcomeReference
    );
  }
  if (normalized.readinessFailure && evidence.outcome === "recorded") {
    await ensureLaneReadinessAlert(
      client,
      normalized.task,
      generation.pipeline,
      normalized.readinessFailure,
      run.html_url,
      polling.maintainer ?? ""
    );
  }
  if (generation.state === "completed") {
    if (evidence.outcome === "recorded" || normalized.outcome && priorOutcome !== normalized.outcome || normalized.outcomeReference && JSON.stringify(priorOutcomeReference) !== JSON.stringify(normalized.outcomeReference)) {
      await saveLedger2(client, loaded);
    }
    return;
  }
  if (generation.state === "active") {
    observeCompletion(loaded.ledger, generation.generation, run.id);
  }
  await saveLedger2(client, loaded);
  if (polling.pollUntilTerminal === false) return;
  const deadline = now() + 12e4;
  let delay = 2e3;
  while (run.status !== "completed" && now() < deadline) {
    await sleep2(delay);
    delay = Math.min(delay * 2, 15e3);
    if (loaded.authority) {
      await persistAuthority(
        loaded.authority,
        loaded.ledger,
        new Date(now()).toISOString()
      );
    }
    try {
      run = await getWorkflowRun(
        client,
        normalized.task,
        normalized.workerRunId
      );
      assertWorkerRun(
        run,
        normalized.task,
        generation,
        expectedWorkflow
      );
    } catch (error) {
      if (error instanceof GitHubApiError && (error.status === 404 || error.status >= 500)) {
        continue;
      }
      throw error;
    }
  }
  if (run.status !== "completed") {
    if (generation.state === "completion-observed") {
      awaitTerminal(loaded.ledger, generation.generation);
      await saveLedger2(client, loaded);
    }
    return;
  }
  completeRun(loaded.ledger, generation.generation, {
    runId: run.id,
    status: run.status,
    conclusion: run.conclusion,
    completedAt: run.updated_at
  });
  await saveLedger2(client, loaded);
}
function resolveTask(normalized) {
  return normalized.kind === "intent" ? normalized.intent.task : (
    // Ignored events are filtered out by broker() before this is ever
    // called; the cast documents that, matching the untyped original's own
    // unguarded `.task` read for every other kind.
    normalized.task
  );
}
var EVICTION_TOLERANT_KINDS = /* @__PURE__ */ new Set(["control-evidence", "reconcile"]);
async function wasSupersededEviction(client, task, runId, group, kind, error) {
  const candidate = error;
  if (candidate?.name !== "BrokerConcurrencyMismatchError" || !candidate.retryable) {
    return false;
  }
  const superseding = await findSupersedingRouterRun(
    client,
    task,
    runId
  );
  if (!superseding) return false;
  if (!EVICTION_TOLERANT_KINDS.has(kind)) {
    throw new Error(
      `Broker run ${runId} (group ${group}, issue #${task.issue}) was evicted from its concurrency queue by newer run ${superseding.id}, but this event carries a '${kind}' payload. Only observational control-evidence/reconcile pings may be dropped on a corroborated eviction (#344, #305); a superseding run does not carry this event's '${kind}' payload forward, since it corresponds to a different triggering event. This event's payload is presumed permanently lost -- a maintainer must manually re-dispatch it to recover.`,
      { cause: error }
    );
  }
  console.log(
    `::notice::Broker run ${runId} (group ${group}, issue #${task.issue}) was evicted from its concurrency queue by newer run ${superseding.id}, which now reports the expected group. Treating this run as superseded rather than failing (#344/#305): this run's own '${kind}' payload for its triggering event is not recorded in the ledger -- the superseding run already carries the issue forward correctly.`
  );
  return true;
}
var FRESH_INTENT_OUTCOMES = /* @__PURE__ */ new Set(["dispatch", "pending"]);
async function healStaleAgentLabels(client, loaded, intent) {
  const staleLabels = intent.staleAgentLabels;
  if (!staleLabels?.length) return;
  const task = loaded.ledger.task;
  const eventLabel = `${intent.mode === "review" ? "review" : "agent"}:${intent.pipeline}`;
  const issue = await client.requestOk(
    `${repositoryPath(task)}/issues/${task.issue}`
  );
  const currentLabels = new Set(
    (issue.labels ?? []).map(
      (label) => typeof label === "string" ? label : label.name
    )
  );
  const removable = [];
  const skipped = [];
  for (const label of staleLabels) {
    if (currentLabels.has(label) && currentLabels.has(eventLabel)) {
      removable.push(label);
    } else {
      skipped.push(label);
    }
  }
  if (skipped.length > 0) {
    console.log(
      `::notice::Skipping stale-label self-heal for ${skipped.join(", ")} on issue #${task.issue}: live labels no longer match the dual-label snapshot this intent was normalized from (current: ${[...currentLabels].join(", ") || "none"}).`
    );
  }
  if (removable.length === 0) return;
  for (const label of removable) {
    await removeIssueLabel(client, task, label);
  }
  const evidence = recordControlEvidence(loaded.ledger, {
    sourceKind: "label-self-heal",
    sourceId: `label-self-heal:${intent.sourceId}`,
    transportRunId: intent.transportRunId,
    occurredAt: (/* @__PURE__ */ new Date()).toISOString(),
    labels: removable,
    authorization: { observed: true, actor: "dispatch-broker" }
  });
  if (evidence.outcome === "recorded") await saveLedger2(client, loaded);
}
async function loadBrokerLedger(client, task, normalized, isPullRequest, storageMode = "off", leaseOwner = "", storagePortFactory = createStoragePort, authorityEpoch = "", projectionIdentities, authorityBusyWaitMs = 13e4) {
  const untrackedPullRequestControl = isPullRequest && normalized.kind === "anchor-control";
  if (storageMode === "authority") {
    const port = storagePortFactory();
    let authority;
    try {
      authority = await acquireAuthority(
        port,
        task,
        leaseOwner,
        createLedger(task),
        {
          // Missing state needs a GitHub projection check below before a new
          // empty aggregate can be created safely.
          createIfMissing: false,
          busyWaitMs: authorityBusyWaitMs
        }
      );
    } catch (error) {
      if (normalized.kind === "completion" && (error instanceof AuthorityStateNotFoundError || error instanceof AuthorityStateMissingError)) {
        throw new CompletionBindingError(
          "Completion callback does not match the bound worker run"
        );
      }
      if (error instanceof AuthorityStateNotFoundError) {
        const initializationEvidence = await classifyAuthorityTaskInitialization(
          client,
          task,
          authorityEpoch,
          projectionIdentities
        );
        if (untrackedPullRequestControl && initializationEvidence !== "compatibility-projection") {
          return void 0;
        }
        if (initializationEvidence !== "post-cutover") {
          throw new AuthorityStateMissingError(task);
        }
        authority = await acquireAuthority(
          port,
          task,
          leaseOwner,
          createLedger(task),
          { busyWaitMs: authorityBusyWaitMs }
        );
      } else {
        throw error;
      }
    }
    if (normalized.kind === "completion") {
      try {
        assertCompletionLedgerBinding(authority.ledger, normalized);
      } catch (error) {
        try {
          await releaseAuthority(authority.session, authority.ledger);
        } catch (releaseError) {
          const message = releaseError instanceof Error ? releaseError.message : String(releaseError);
          console.log(
            `::warning::Failed to release rejected completion lease; it will expire automatically: ${message}`
          );
        }
        throw error;
      }
    }
    try {
      const projected = await loadLedgerProjection(
        client,
        task,
        authority.ledger,
        projectionIdentities
      );
      projected.authority = authority.session;
      projected.projectionAvailable = true;
      return projected;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        `::warning::Loaded authoritative Firestore state for ${task.repository}#${task.issue}, but its GitHub ledger projection is unavailable this pass: ${message}`
      );
      return {
        ledger: authority.ledger,
        comment: { id: 0, body: "", created_at: "" },
        created: false,
        authority: authority.session,
        projectionAvailable: false
      };
    }
  }
  const loaded = await loadLedger(
    client,
    task,
    void 0,
    {
      createIfMissing: !untrackedPullRequestControl
    }
  );
  return loaded;
}
async function applyAnchorControlTransition(client, loaded, control) {
  applyAnchorControl(loaded.ledger, control);
  await saveLedger2(client, loaded);
}
async function processNormalizedEvent({
  normalized,
  githubToken,
  storageMode: storageModeInput,
  authorityEpoch: authorityEpochInput = "",
  storagePortFactory,
  isPullRequest,
  transportRunId: runId,
  authorityOwner,
  maintainer = "",
  actionConcurrency,
  projectionIdentities,
  pollCompletionUntilTerminal = true,
  authorityBusyWaitMs = 13e4
}) {
  if (normalized.kind === "ignored") return;
  const storageMode = parseDispatchStorageMode(storageModeInput);
  const authorityEpoch = storageMode === "authority" ? authorityEpochInput : "";
  const task = resolveTask(normalized);
  const client = createGitHubApi({ token: githubToken });
  if (actionConcurrency) {
    const { eventName, group } = actionConcurrency;
    try {
      await verifyBrokerConcurrency(client, task, runId, group, { eventName });
    } catch (error) {
      if (await wasSupersededEviction(
        client,
        task,
        runId,
        group,
        normalized.kind,
        error
      )) {
        return;
      }
      throw error;
    }
  }
  if (normalized.kind === "completion" && storageMode !== "authority") {
    await assertCompletionBindingBeforeInitialization(
      client,
      task,
      normalized,
      storageMode,
      storagePortFactory
    );
  }
  let loaded;
  try {
    loaded = await loadBrokerLedger(
      client,
      task,
      normalized,
      isPullRequest,
      storageMode,
      authorityOwner,
      storagePortFactory,
      authorityEpoch,
      projectionIdentities,
      authorityBusyWaitMs
    );
  } catch (error) {
    if (error instanceof TaskLeaseBusyError) {
      console.log(
        `::warning::Deferring ${task.repository}#${task.issue}: ${error.message}`
      );
      throw error;
    }
    if (error instanceof CompletionBindingError) throw error;
    await failClosed(client, task, maintainer, error);
  }
  if (!loaded) {
    console.log(
      // Only reachable when loadBrokerLedger's own untrackedPullRequestControl
      // gate fired, i.e. normalized.kind === 'anchor-control' -- same
      // assumption the untyped original made without checking.
      `::notice::Ignoring ${normalized.control.kind} for untracked pull request #${task.issue}; no dispatch ledger exists.`
    );
    return;
  }
  try {
    if (normalized.kind === "completion") {
      assertCompletionLedgerBinding(loaded.ledger, normalized);
    }
    await pinLedgerWhenUnoccupied(client, loaded, isPullRequest);
    try {
      if (normalized.kind === "reconcile") {
        await runPhase(
          { client, loaded },
          "reconciliation",
          () => reconcileControlState(
            client,
            loaded,
            normalized.issueClosed,
            (/* @__PURE__ */ new Date()).toISOString(),
            runId
          )
        );
      }
      await reconcileActive(
        client,
        loaded,
        (/* @__PURE__ */ new Date()).toISOString(),
        maintainer
      );
      if (normalized.kind === "intent") {
        const accepted = await runPhase(
          { client, loaded },
          "intent",
          () => acceptIntent(loaded.ledger, normalized.intent)
        );
        await saveLedger2(client, loaded);
        if (FRESH_INTENT_OUTCOMES.has(accepted.outcome)) {
          await healStaleAgentLabels(client, loaded, normalized.intent);
        }
      } else if (normalized.kind === "anchor-control") {
        await applyAnchorControlTransition(client, loaded, normalized.control);
      } else if (normalized.kind === "control-evidence") {
        recordControlEvidence(loaded.ledger, normalized.evidence);
        await saveLedger2(client, loaded);
      } else if (normalized.kind === "completion") {
        await handleCompletion(client, loaded, normalized, {
          pollUntilTerminal: pollCompletionUntilTerminal,
          maintainer
        });
      } else if (normalized.kind === "reconcile") {
        await runPhase(
          { client, loaded },
          "reconciliation",
          () => reconcileLedger(
            client,
            loaded,
            (/* @__PURE__ */ new Date()).toISOString(),
            runId,
            normalized.issueClosed,
            maintainer
          )
        );
      } else {
        throw new Error(
          `Unsupported normalized event kind: ${normalized.kind}`
        );
      }
      await dispatchAccepted(client, loaded);
      try {
        await saveProjectionCheckpoint(client, loaded);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(
          `::warning::Failed to record the projector's convergence checkpoint: ${message}`
        );
      }
      await maybeObserveDispatchStorage(
        storageMode,
        storagePortFactory,
        loaded.ledger
      );
    } catch (error) {
      await failClosed(client, task, maintainer, error);
    }
  } finally {
    if (loaded?.authority) {
      try {
        await releaseAuthority(loaded.authority, loaded.ledger);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(
          `::warning::Failed to release dispatch-storage authority lease; it will expire automatically: ${message}`
        );
      }
    }
  }
}
async function broker() {
  const normalized = decode(env("BROKER_PAYLOAD"));
  const runId = Number(env("GITHUB_RUN_ID"));
  const hostedControllerLogin = env("HOSTED_CONTROLLER_LOGIN", false);
  await processNormalizedEvent({
    normalized,
    githubToken: env("GITHUB_TOKEN"),
    storageMode: env("DISPATCH_STORAGE_MODE", false),
    authorityEpoch: env("DISPATCH_AUTHORITY_EPOCH", false),
    storagePortFactory: createStoragePort,
    isPullRequest: env("ANCHOR_IS_PR", false) === "true",
    transportRunId: runId,
    authorityOwner: `action:${runId}`,
    maintainer: env("MAINTAINER_LOGIN", false),
    actionConcurrency: {
      group: env("BROKER_GROUP"),
      eventName: env("GITHUB_EVENT_NAME", false)
    },
    projectionIdentities: [
      { login: "github-actions[bot]", type: "Bot" },
      ...hostedControllerLogin ? [{ login: hostedControllerLogin, type: "User" }] : []
    ]
  });
}
async function preflight() {
  const task = {
    repositoryId: Number(env("GITHUB_REPOSITORY_ID")),
    repository: env("GITHUB_REPOSITORY"),
    issue: Number(env("BROKER_ISSUE"))
  };
  const expected = {
    task,
    generation: Number(env("BROKER_GENERATION")),
    intentId: env("BROKER_INTENT_ID"),
    token: env("BROKER_DISPATCH_TOKEN"),
    runId: Number(env("GITHUB_RUN_ID"))
  };
  const client = api();
  const storageMode = parseDispatchStorageMode(
    env("DISPATCH_STORAGE_MODE", false)
  );
  const authorityPort = storageMode === "authority" ? createStoragePort() : void 0;
  await runPhase(void 0, "authorization", async () => {
    const deadline = Date.now() + 6e4;
    while (Date.now() < deadline) {
      const ledger = await loadPreflightLedger(
        client,
        task,
        storageMode,
        authorityPort
      );
      if (ledger && verifyPreflight(ledger, expected)) {
        const generation = ledger.generations.find(
          (candidate) => candidate.generation === expected.generation
        );
        const run = await getWorkflowRun(
          client,
          task,
          expected.runId
        );
        assertWorkerRun(
          run,
          task,
          generation,
          workerWorkflow(generation.pipeline)
        );
        await output("authorized", "true");
        await output(
          "attempt-id",
          formatAttemptId({
            generation: expected.generation,
            intentId: expected.intentId
          })
        );
        const priorTerminal = ledger.generations.filter(
          (candidate) => candidate.generation < expected.generation && [
            "completed",
            "dispatch-rejected",
            "superseded",
            "superseded-by-close"
          ].includes(candidate.state)
        ).sort((left, right) => right.generation - left.generation)[0];
        await output(
          "prior-terminal-state",
          JSON.stringify(
            priorTerminal ? {
              generation: priorTerminal.generation,
              state: priorTerminal.state,
              pipeline: priorTerminal.pipeline,
              mode: priorTerminal.mode ?? null,
              outcome: priorTerminal.attempt?.outcome ?? null,
              conclusion: priorTerminal.attempt?.conclusion ?? null,
              completedAt: priorTerminal.attempt?.completedAt ?? null
            } : null
          )
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2e3));
    }
    throw new Error(
      "Worker preflight could not verify an exact broker binding"
    );
  });
}
async function loadPreflightLedger(client, task, storageMode, authorityPort) {
  if (storageMode === "authority") {
    if (!authorityPort) {
      throw new Error("Authority preflight requires a dispatch storage port");
    }
    return (await authorityPort.readTask(task))?.controllerState;
  }
  return (await loadLedger(client, task, "github-actions[bot]", {
    createIfMissing: false
  }))?.ledger;
}
async function completionCallback() {
  const outcomeInput = env("BROKER_OUTCOME_KIND", false);
  const outcomeReference = env("BROKER_OUTCOME_REFERENCE", false);
  const readinessFailureInput = env("BROKER_READINESS_FAILURE", false);
  let outcome;
  if (outcomeInput) {
    if (!isDispatchOutcomeKind(outcomeInput)) {
      throw new Error("BROKER_OUTCOME_KIND is not a recognized outcome");
    }
    outcome = outcomeInput;
  }
  let readinessFailure;
  if (readinessFailureInput) {
    if (!isLaneReadinessFailure(readinessFailureInput)) {
      throw new Error(
        "BROKER_READINESS_FAILURE is not a recognized readiness failure"
      );
    }
    readinessFailure = readinessFailureInput;
  }
  if (outcomeReference) {
    const number = Number(outcomeReference);
    if (outcome !== "pull-request" || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error(
        "BROKER_OUTCOME_REFERENCE requires a positive PR number and pull-request outcome"
      );
    }
  }
  await sendHostedCompletion({
    completionUrl: HOSTED_COMPLETION_URL,
    oidcRequestUrl: env("ACTIONS_ID_TOKEN_REQUEST_URL"),
    oidcRequestToken: env("ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
    payload: {
      issue: Number(env("BROKER_ISSUE")),
      generation: Number(env("BROKER_GENERATION")),
      intentId: env("BROKER_INTENT_ID"),
      token: env("BROKER_DISPATCH_TOKEN"),
      workflow: env("BROKER_WORKER_WORKFLOW"),
      ...outcome ? { outcome } : {},
      ...outcomeReference ? {
        outcomeReference: {
          kind: "pull-request",
          number: Number(outcomeReference)
        }
      } : {},
      ...readinessFailure ? { readinessFailure } : {}
    }
  });
}
function trustedActionsRunUrl(value) {
  const serverUrl = env("GITHUB_SERVER_URL").replace(/\/$/u, "");
  const repository = env("GITHUB_REPOSITORY");
  const prefix = `${serverUrl}/${repository}/actions/runs/`;
  const runId = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  if (!/^\d+$/u.test(runId)) {
    throw new Error(
      "BROKER_EVIDENCE_URL must be an exact run URL in this repository"
    );
  }
  return value;
}
async function projectClaudeReadiness(client, task, state, evidenceUrl, maintainer) {
  if (state === "credential-failure") {
    await ensureLaneReadinessAlert(
      client,
      task,
      "claude",
      "credential",
      evidenceUrl,
      maintainer,
      "probe"
    );
    return 1;
  }
  const resolved = await resolveLaneReadinessAlerts(
    client,
    task,
    "claude",
    evidenceUrl
  );
  return resolved.length;
}
async function claudeReadiness() {
  const state = env(
    "BROKER_READINESS_STATE"
  );
  if (state !== "credential-failure" && state !== "healthy") {
    throw new Error(
      "BROKER_READINESS_STATE must be credential-failure or healthy"
    );
  }
  const evidenceUrl = trustedActionsRunUrl(env("BROKER_EVIDENCE_URL"));
  const task = {
    repositoryId: Number(env("GITHUB_REPOSITORY_ID")),
    repository: env("GITHUB_REPOSITORY"),
    // Lane incidents are repository-level health projections. The helper
    // accepts a canonical TaskRef because all other readiness callers have
    // one, but neither open nor resolve reads this sentinel issue number.
    issue: 0
  };
  const count = await projectClaudeReadiness(
    api(),
    task,
    state,
    evidenceUrl,
    env("MAINTAINER_LOGIN", false)
  );
  await output("readiness-incidents", String(count));
}
async function classifyClaudeReadinessProbe() {
  const executionFile = env("BROKER_EXECUTION_FILE", false);
  const conclusion = env("BROKER_PROBE_CONCLUSION", false);
  let execution;
  if (executionFile) {
    try {
      execution = JSON.parse(await fs.readFile(executionFile, "utf8"));
    } catch {
    }
  }
  await output(
    "readiness-state",
    classifyClaudeReadiness(conclusion, execution)
  );
}
async function discoverReconcileCandidates2(client, repository, fleetLogin) {
  return discoverReconcileCandidates(
    createReconcileTransport(client),
    repository,
    fleetLogin
  );
}
async function discoverRecentlyClosedReconcileCandidates2(client, repository, fleetLogin, now = /* @__PURE__ */ new Date()) {
  return discoverRecentlyClosedReconcileCandidates(
    createReconcileTransport(client),
    repository,
    fleetLogin,
    now
  );
}
async function scanReconcile() {
  const client = api();
  const repository = env("GITHUB_REPOSITORY");
  const fleetLogin = env("AGENT_FLEET_LOGIN", false);
  const results = await runReconcileScan(
    createReconcileTransport(client),
    repository,
    fleetLogin
  );
  console.log(
    `::notice::dispatch-reconcile: fired reconcile for ${results.dispatched}/${results.candidates} candidate(s) (${results.openCandidates} open agent-labeled/fleet-assigned, ${results.closedCandidates} recently-closed agent-labeled/fleet-assigned).`
  );
  for (const failure of results.failed) {
    console.log(
      `::error::dispatch-reconcile: failed to dispatch reconcile for #${failure.issue}: ${failure.message}`
    );
  }
  await output("candidates", String(results.candidates));
  await output("dispatched", String(results.dispatched));
  if (results.failed.length > 0) {
    throw new Error(
      `Reconcile scan failed to dispatch ${results.failed.length}/${results.candidates} candidate(s): ` + results.failed.map((failure) => `#${failure.issue}`).join(", ")
    );
  }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const operation = process.argv[2];
  if (operation === "normalize") await normalize();
  else if (operation === "broker") await broker();
  else if (operation === "preflight") await preflight();
  else if (operation === "completion-callback") await completionCallback();
  else if (operation === "reconcile") await scanReconcile();
  else if (operation === "classify-claude-readiness")
    await classifyClaudeReadinessProbe();
  else if (operation === "claude-readiness") await claudeReadiness();
  else throw new Error(`Unsupported dispatch broker operation: ${operation}`);
}
export {
  CompletionBindingError,
  FRESH_INTENT_OUTCOMES,
  RECONCILE_DISPATCH_CONCURRENCY,
  RECONCILE_MISSING_RUN_GRACE_MS,
  RECONCILE_MISSING_RUN_MAX_ATTEMPTS,
  RECONCILE_MISSING_RUN_MIN_INTERVAL_MS,
  RECONCILE_STUCK_RUN_GRACE_MS,
  RECONCILE_STUCK_RUN_MAX_ATTEMPTS,
  RECONCILE_STUCK_RUN_MIN_INTERVAL_MS,
  anchorNeedsHuman,
  applyAnchorControlTransition,
  assertCompletionBindingBeforeInitialization,
  assertCompletionLedgerBinding,
  assertWorkerRun,
  completionMatches,
  contextFor,
  decode,
  discoverRecentlyClosedReconcileCandidates2 as discoverRecentlyClosedReconcileCandidates,
  discoverReconcileCandidates2 as discoverReconcileCandidates,
  dispatchAccepted,
  dispatchReconcileScan2 as dispatchReconcileScan,
  encode,
  handleCompletion,
  healStaleAgentLabels,
  holdForLaneReadiness,
  isDefiniteDispatchRejection,
  loadBrokerLedger,
  loadPreflightLedger,
  processNormalizedEvent,
  projectClaudeReadiness,
  reconcileActive,
  reconcileControlState,
  reconcileLedger,
  repairMissingIntentFromLabel,
  resolveTask,
  runPhase,
  saveProjectionCheckpoint,
  trustedActionsRunUrl,
  wasSupersededEviction
};
