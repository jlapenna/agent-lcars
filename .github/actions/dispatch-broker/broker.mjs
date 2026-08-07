import crypto from 'node:crypto';

import {
  extractLedgerComment,
  LEDGER_MARKER,
  LEDGER_SCHEMA,
  renderLedgerComment as renderLedgerCommentContract,
} from '../../../libs/dispatch-contracts/src/index.js';
// #645 Phase 2: intent acceptance/ordering and the generation state machine
// now live in their own modules, over the ledger primitives in
// modules/ledger-core.mjs. broker.mjs imports all three back here purely to
// re-export under the names this file has always exported, so every existing
// importer (main.mjs, broker.test.mjs, ledger-contract.test.mjs,
// workflow-contract.test.mjs) keeps working unchanged.
//
// The dependency runs one way on purpose. Having intent/scheduler import
// their primitives back out of this file would be an ESM cycle that happens
// to work -- it survives only while nothing reads an imported binding at
// module-evaluation time, and one ordinary top-level `const` in either module
// would turn it into a temporal-dead-zone crash at import time, in the
// control plane. ledger-core.mjs exists so that cannot happen.
import {
  acceptIntent,
  compareIntentOrder,
  validateIntent,
} from './modules/intent.mjs';
import {
  ACTIVE_STATES,
  assertTaskRef,
  createLedger,
  mutate,
  validateLedger,
} from './modules/ledger-core.mjs';
import {
  awaitTerminal,
  beginDispatch,
  bindRun,
  completeRun,
  markDispatchRejected,
  markDispatchUnknown,
  observeCompletion,
  verifyPreflight,
} from './modules/scheduler.mjs';

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

function parseLedgerComment(body, task) {
  const extraction = extractLedgerComment(body);
  if (!extraction.ok) {
    if (extraction.reason === 'no-marker') {
      throw new Error('Dispatch ledger marker missing');
    }
    if (extraction.reason === 'block-count') {
      throw new Error('Malformed dispatch ledger: expected one JSON block');
    }
    // extraction.reason === 'invalid-json'
    throw new Error('Malformed dispatch ledger: invalid JSON');
  }
  return validateLedger(extraction.ledger, task);
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
  return renderLedgerCommentContract(ledger, visibleSummary(ledger));
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

/**
 * `failure` is an optional `FailureClassification` (#645's
 * owning-system/phase/reason/retry vocabulary from
 * ../../../libs/dispatch-contracts/src/failure.js), appended as a fifth
 * positional parameter rather than inserted before `now` so every existing
 * call -- including ledger-contract.test.mjs's, which calls this directly
 * with (ledger, kind, detail, now) -- keeps meaning exactly what it did
 * before. Omitted, the anomaly record carries no `failure` key at all
 * (not an explicit `undefined`), identical to every anomaly recorded prior
 * to this field existing.
 */
function addAnomaly(
  ledger,
  kind,
  detail,
  now = new Date().toISOString(),
  failure,
) {
  return mutate(ledger, now, () => {
    ledger.anomalies.push({
      kind,
      detail,
      occurredAt: now,
      ...(failure === undefined ? {} : { failure }),
    });
  });
}

export {
  acceptIntent,
  ACTIVE_STATES,
  addAnomaly,
  applyAnchorControl,
  assertTaskRef,
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
  mutate,
  observeCompletion,
  parseLedgerComment,
  recordControlEvidence,
  renderLedgerComment,
  validateIntent,
  validateLedger,
  verifyPreflight,
};
