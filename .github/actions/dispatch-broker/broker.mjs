import crypto from 'node:crypto';

import { isDispatchPipeline } from '../../../libs/dispatch-contracts/src/index.js';

const LEDGER_MARKER = '<!-- agent-lcars:dispatch-ledger:v1 -->';
const LEDGER_SCHEMA = 'agent-lcars.dispatch-ledger/v1';
const ACTIVE_STATES = new Set([
  'dispatching',
  'dispatch-unknown',
  'active',
  'completion-observed',
  'completion-awaiting-terminal',
]);
const TERMINAL_RUN_STATUSES = new Set(['completed']);
// 'canary' (#307) is a dedicated, structurally-no-op fourth pipeline: it
// exists purely to prove the broker's own claim/dispatch/completion-
// callback path in production without ever invoking a paid model or a
// self-hosted/privileged runner. Why it is unreachable by label now lives
// with the shared pipeline registry -- see
// libs/dispatch-contracts/src/pipelines.js's canary contract.

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function compareIntentOrder(left, right) {
  const byTime = left.occurredAt.localeCompare(right.occurredAt);
  return byTime || left.sourceId.localeCompare(right.sourceId);
}

function assertTaskRef(task) {
  if (
    !task ||
    !Number.isSafeInteger(task.repositoryId) ||
    task.repositoryId <= 0 ||
    !/^[^/]+\/[^/]+$/u.test(task.repository) ||
    !Number.isSafeInteger(task.issue) ||
    task.issue <= 0
  ) {
    throw new Error('Invalid canonical TaskRef');
  }
}

function createLedger(task, now = new Date().toISOString()) {
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
    anomalies: [],
  };
}

function validateLedger(ledger, task) {
  if (!ledger || ledger.schema !== LEDGER_SCHEMA) {
    throw new Error('Malformed dispatch ledger: unsupported schema');
  }
  assertTaskRef(ledger.task);
  assertTaskRef(task);
  if (
    ledger.task.repositoryId !== task.repositoryId ||
    ledger.task.repository.toLowerCase() !== task.repository.toLowerCase() ||
    ledger.task.issue !== task.issue
  ) {
    throw new Error('Malformed dispatch ledger: canonical TaskRef mismatch');
  }
  if (!Number.isSafeInteger(ledger.revision) || ledger.revision < 0) {
    throw new Error('Malformed dispatch ledger: invalid revision');
  }
  if (!Array.isArray(ledger.sources) || !Array.isArray(ledger.generations)) {
    throw new Error('Malformed dispatch ledger: missing history');
  }
  const active = ledger.generations.filter((generation) =>
    ACTIVE_STATES.has(generation.state),
  );
  const pending = ledger.generations.filter(
    (generation) => generation.state === 'pending',
  );
  if (active.length > 1 || pending.length > 1) {
    throw new Error(
      'Malformed dispatch ledger: invalid active/pending cardinality',
    );
  }
  return ledger;
}

function parseLedgerComment(body, task) {
  if (typeof body !== 'string' || !body.includes(LEDGER_MARKER)) {
    throw new Error('Dispatch ledger marker missing');
  }
  const matches = [...body.matchAll(/```json\s*([\s\S]*?)\s*```/gu)];
  if (matches.length !== 1) {
    throw new Error('Malformed dispatch ledger: expected one JSON block');
  }
  let ledger;
  try {
    ledger = JSON.parse(matches[0][1]);
  } catch {
    throw new Error('Malformed dispatch ledger: invalid JSON');
  }
  return validateLedger(ledger, task);
}

function visibleSummary(ledger) {
  const active = ledger.generations.find((generation) =>
    ACTIVE_STATES.has(generation.state),
  );
  const pending = ledger.generations.find(
    (generation) => generation.state === 'pending',
  );
  const closed = ledger.control.closed ? ' · anchor closed' : '';
  if (active) {
    const run = active.attempt?.runId ? ` · run ${active.attempt.runId}` : '';
    const queued = pending ? ` · pending g${pending.generation}` : '';
    return `Dispatch broker: g${active.generation} ${active.pipeline} is ${active.state}${run}${queued}${closed}.`;
  }
  const latest = ledger.generations.at(-1);
  return latest
    ? `Dispatch broker: g${latest.generation} is ${latest.state}${closed}.`
    : `Dispatch broker: waiting for an authorized intent${closed}.`;
}

function renderLedgerComment(ledger) {
  return `${LEDGER_MARKER}\n${visibleSummary(ledger)}\n\n<details><summary>Machine state</summary>\n\n\`\`\`json\n${JSON.stringify(ledger)}\n\`\`\`\n\n</details>`;
}

function mutate(ledger, now, callback) {
  callback();
  ledger.revision += 1;
  ledger.updatedAt = now;
  validateLedger(ledger, ledger.task);
  return ledger;
}

function sourceEvidence(intent) {
  return {
    intentId: intent.intentId,
    sourceKind: intent.sourceKind,
    sourceId: intent.sourceId,
    transportRunId: intent.transportRunId,
    occurredAt: intent.occurredAt,
    digest: intent.digest,
    authorization: intent.authorization,
  };
}

function validateIntent(intent, task) {
  assertTaskRef(intent?.task);
  assertTaskRef(task);
  if (
    intent.task.repositoryId !== task.repositoryId ||
    intent.task.repository.toLowerCase() !== task.repository.toLowerCase() ||
    intent.task.issue !== task.issue
  ) {
    throw new Error('Intent TaskRef mismatch');
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(intent.intentId ?? '')) {
    throw new Error('Invalid intent ID');
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(intent.sourceId ?? '')) {
    throw new Error('Invalid source ID');
  }
  if (
    !Number.isSafeInteger(intent.transportRunId) ||
    intent.transportRunId <= 0
  ) {
    throw new Error('Invalid transport run ID');
  }
  if (Number.isNaN(Date.parse(intent.occurredAt))) {
    throw new Error('Invalid intent occurrence time');
  }
  if (!isDispatchPipeline(intent.pipeline))
    throw new Error('Unsupported pipeline');
  if (!intent.authorization?.authorized) throw new Error('Unauthorized intent');
}

function generationForIntent(ledger, intentId) {
  return ledger.generations.find(
    (generation) => generation.intentId === intentId,
  );
}

function acceptIntent(ledger, intent, now = new Date().toISOString()) {
  validateLedger(ledger, intent.task);
  validateIntent(intent, ledger.task);

  const sourceDuplicate = ledger.sources.some(
    (source) =>
      source.sourceKind === intent.sourceKind &&
      source.sourceId === intent.sourceId,
  );
  const transportDuplicate = ledger.sources.some(
    (source) => source.transportRunId === intent.transportRunId,
  );
  if (sourceDuplicate || transportDuplicate) {
    return { outcome: 'duplicate', ledger };
  }

  const existing = generationForIntent(ledger, intent.intentId);
  if (existing) {
    if (existing.digest !== intent.digest) {
      throw new Error('Semantic intent ID was reused with a different digest');
    }
    mutate(ledger, now, () => ledger.sources.push(sourceEvidence(intent)));
    return {
      outcome: 'semantic-duplicate',
      generation: existing.generation,
      ledger,
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
    state: 'accepted',
  };

  let outcome = 'dispatch';
  mutate(ledger, now, () => {
    ledger.sources.push(sourceEvidence(intent));
    ledger.generations.push(generation);
    if (intent.dispatchable === false) {
      generation.state = 'superseded';
      outcome = 'stale-control-state';
      return;
    }
    if (ledger.control.closed) {
      generation.state = 'superseded-by-close';
      outcome = 'closed';
      return;
    }
    const active = ledger.generations.find(
      (candidate) =>
        candidate !== generation && ACTIVE_STATES.has(candidate.state),
    );
    const pending = ledger.generations.find(
      (candidate) => candidate !== generation && candidate.state === 'pending',
    );
    const newestDesired = pending ?? active;
    if (newestDesired && compareIntentOrder(intent, newestDesired) <= 0) {
      generation.state = 'superseded';
      outcome = 'stale';
      return;
    }
    if (active) {
      if (pending) pending.state = 'superseded';
      generation.state = 'pending';
      outcome = 'pending';
      return;
    }
    if (pending) pending.state = 'superseded';
    generation.state = 'accepted';
  });
  return { outcome, generation: generation.generation, ledger };
}

function beginDispatch(
  ledger,
  generationNumber,
  token,
  now = new Date().toISOString(),
) {
  const generation = ledger.generations.find(
    (candidate) => candidate.generation === generationNumber,
  );
  if (!generation || !['accepted', 'pending'].includes(generation.state)) {
    throw new Error('Generation is not dispatchable');
  }
  if (ledger.control.closed) throw new Error('Closed anchor cannot dispatch');
  if (
    ledger.generations.some((candidate) => ACTIVE_STATES.has(candidate.state))
  ) {
    throw new Error('Another generation is active');
  }
  if (!/^[A-Za-z0-9_-]{16,200}$/u.test(token))
    throw new Error('Invalid dispatch token');
  return mutate(ledger, now, () => {
    generation.state = 'dispatching';
    generation.attempt = { token, dispatchStartedAt: now };
  });
}

function markDispatchUnknown(
  ledger,
  generationNumber,
  reason,
  now = new Date().toISOString(),
) {
  const generation = ledger.generations.find(
    (candidate) => candidate.generation === generationNumber,
  );
  if (!generation || generation.state !== 'dispatching') {
    throw new Error('Generation is not dispatching');
  }
  return mutate(ledger, now, () => {
    generation.state = 'dispatch-unknown';
    generation.attempt.unknownAt = now;
    generation.attempt.unknownReason = reason;
  });
}

function markDispatchRejected(
  ledger,
  generationNumber,
  reason,
  now = new Date().toISOString(),
) {
  const generation = ledger.generations.find(
    (candidate) => candidate.generation === generationNumber,
  );
  if (!generation || generation.state !== 'dispatching') {
    throw new Error('Generation is not dispatching');
  }
  let promoted;
  mutate(ledger, now, () => {
    generation.state = 'dispatch-rejected';
    generation.attempt.rejectedAt = now;
    generation.attempt.rejectionReason = reason;
    if (!ledger.control.closed) {
      promoted = ledger.generations.find(
        (candidate) => candidate.state === 'pending',
      );
      if (promoted) promoted.state = 'accepted';
    }
  });
  return { ledger, promotedGeneration: promoted?.generation };
}

function bindRun(
  ledger,
  generationNumber,
  binding,
  now = new Date().toISOString(),
) {
  const generation = ledger.generations.find(
    (candidate) => candidate.generation === generationNumber,
  );
  if (
    !generation ||
    !['dispatching', 'dispatch-unknown'].includes(generation.state)
  ) {
    throw new Error('Generation is not awaiting a run binding');
  }
  if (
    !Number.isSafeInteger(binding.runId) ||
    binding.runId <= 0 ||
    typeof binding.runUrl !== 'string' ||
    typeof binding.htmlUrl !== 'string'
  ) {
    throw new Error('Invalid workflow run binding');
  }
  return mutate(ledger, now, () => {
    generation.state = 'active';
    Object.assign(generation.attempt, binding, { boundAt: now });
  });
}

function observeCompletion(
  ledger,
  generationNumber,
  runId,
  now = new Date().toISOString(),
) {
  const generation = ledger.generations.find(
    (candidate) => candidate.generation === generationNumber,
  );
  if (
    !generation ||
    !['active', 'completion-observed', 'completion-awaiting-terminal'].includes(
      generation.state,
    ) ||
    generation.attempt?.runId !== runId
  ) {
    throw new Error('Completion does not match the active run');
  }
  return mutate(ledger, now, () => {
    generation.state = 'completion-observed';
    generation.attempt.completionObservedAt ??= now;
  });
}

function awaitTerminal(
  ledger,
  generationNumber,
  now = new Date().toISOString(),
) {
  const generation = ledger.generations.find(
    (candidate) => candidate.generation === generationNumber,
  );
  if (!generation || generation.state !== 'completion-observed') {
    throw new Error('Completion has not been observed');
  }
  return mutate(ledger, now, () => {
    generation.state = 'completion-awaiting-terminal';
    generation.attempt.lastObservedAt = now;
  });
}

function completeRun(
  ledger,
  generationNumber,
  observation,
  now = new Date().toISOString(),
) {
  const generation = ledger.generations.find(
    (candidate) => candidate.generation === generationNumber,
  );
  if (
    !generation ||
    !['active', 'completion-observed', 'completion-awaiting-terminal'].includes(
      generation.state,
    ) ||
    generation.attempt?.runId !== observation.runId ||
    !TERMINAL_RUN_STATUSES.has(observation.status) ||
    typeof observation.conclusion !== 'string'
  ) {
    throw new Error('Invalid terminal run observation');
  }
  let promoted;
  mutate(ledger, now, () => {
    generation.state = 'completed';
    generation.attempt.status = observation.status;
    generation.attempt.conclusion = observation.conclusion;
    generation.attempt.completedAt = observation.completedAt ?? now;
    if (!ledger.control.closed) {
      promoted = ledger.generations.find(
        (candidate) => candidate.state === 'pending',
      );
      if (promoted) promoted.state = 'accepted';
    }
  });
  return { ledger, promotedGeneration: promoted?.generation };
}

function applyAnchorControl(ledger, control, now = new Date().toISOString()) {
  if (!['closed', 'reopened'].includes(control.kind))
    throw new Error('Invalid anchor control');
  if (!control.sourceId) throw new Error('Anchor control source ID missing');
  if (ledger.sources.some((source) => source.sourceId === control.sourceId)) {
    return { outcome: 'duplicate', ledger };
  }
  mutate(ledger, now, () => {
    ledger.sources.push({
      sourceKind: control.kind,
      sourceId: control.sourceId,
      transportRunId: control.transportRunId,
      occurredAt: control.occurredAt,
      authorization: control.authorization,
    });
    ledger.control = {
      closed: control.kind === 'closed',
      sourceId: control.sourceId,
      occurredAt: control.occurredAt,
      merged: control.kind === 'closed' && Boolean(control.merged),
    };
    if (control.kind === 'closed') {
      for (const generation of ledger.generations) {
        if (generation.state === 'pending' || generation.state === 'accepted') {
          generation.state = 'superseded-by-close';
        }
      }
    }
  });
  return { outcome: control.kind, ledger };
}

function recordControlEvidence(
  ledger,
  evidence,
  now = new Date().toISOString(),
) {
  const duplicate = ledger.sources.some(
    (source) =>
      source.sourceKind === evidence.sourceKind &&
      source.sourceId === evidence.sourceId,
  );
  if (duplicate) return { outcome: 'duplicate', ledger };
  mutate(ledger, now, () => ledger.sources.push(structuredClone(evidence)));
  return { outcome: 'recorded', ledger };
}

function verifyPreflight(ledger, expected) {
  validateLedger(ledger, expected.task);
  const generation = ledger.generations.find(
    (candidate) => candidate.generation === expected.generation,
  );
  return Boolean(
    generation &&
    ['active', 'completion-observed', 'completion-awaiting-terminal'].includes(
      generation.state,
    ) &&
    generation.intentId === expected.intentId &&
    generation.attempt?.token === expected.token &&
    generation.attempt?.runId === expected.runId,
  );
}

function addAnomaly(ledger, kind, detail, now = new Date().toISOString()) {
  return mutate(ledger, now, () => {
    ledger.anomalies.push({ kind, detail, occurredAt: now });
  });
}

export {
  acceptIntent,
  ACTIVE_STATES,
  addAnomaly,
  applyAnchorControl,
  awaitTerminal,
  beginDispatch,
  bindRun,
  canonicalJson,
  compareIntentOrder,
  completeRun,
  createLedger,
  digest,
  LEDGER_MARKER,
  LEDGER_SCHEMA,
  markDispatchRejected,
  markDispatchUnknown,
  observeCompletion,
  parseLedgerComment,
  recordControlEvidence,
  renderLedgerComment,
  validateIntent,
  validateLedger,
  verifyPreflight,
};
