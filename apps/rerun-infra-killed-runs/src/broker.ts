import crypto from 'node:crypto';

import type {
  DispatchLedger,
  FailureClassification,
  LedgerAuthorization,
  LedgerSource,
  LedgerTaskRef,
} from '@agent-lcars/dispatch-contracts';
import {
  extractLedgerComment,
  LEDGER_MARKER,
  LEDGER_SCHEMA,
  renderLedgerComment as renderLedgerCommentContract,
} from '@agent-lcars/dispatch-contracts';

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
} from './modules/intent';
import {
  ACTIVE_STATES,
  assertTaskRef,
  createLedger,
  mutate,
  validateLedger,
} from './modules/ledger-core';
import {
  abandonPendingLaunchForClosedAnchor,
  awaitTerminal,
  beginDispatch,
  bindRun,
  completeRun,
  markDispatchRejected,
  markDispatchUnknown,
  observeCompletion,
  recordOutcome,
  restoreAcceptedForLaunchRetry,
  verifyPreflight,
} from './modules/scheduler';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    // `typeof value === 'object'` proves an object, not that it is safe to
    // index by arbitrary string keys -- Object.keys() below only ever hands
    // back the object's own keys, so indexing with one of them is safe.
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function parseLedgerComment(body: string, task: LedgerTaskRef): DispatchLedger {
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

function visibleSummary(ledger: DispatchLedger): string {
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

function renderLedgerComment(ledger: DispatchLedger): string {
  return renderLedgerCommentContract(ledger, visibleSummary(ledger));
}

/**
 * The anchor-control signal normalize.mjs produces for a pull request
 * close/reopen or an issue closed/reopened event -- see its two
 * `kind: 'anchor-control'` branches.
 */
export interface AnchorControl {
  kind: 'closed' | 'reopened';
  sourceId: string;
  occurredAt: string;
  transportRunId: number;
  authorization: LedgerAuthorization;
  merged: boolean;
}

export type AnchorControlOutcome = 'duplicate' | 'closed' | 'reopened';

function applyAnchorControl(
  ledger: DispatchLedger,
  control: AnchorControl,
  now: string = new Date().toISOString(),
): { outcome: AnchorControlOutcome; ledger: DispatchLedger } {
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

/**
 * The evidence recorded for a completion callback or an unlabeled/label-
 * repair event -- a `LedgerSource` plus the handful of extra fields those
 * two call sites (main.mjs's `handleCompletion`, normalize.mjs's
 * `unlabeled` branch) attach for their own audit purposes. Not part of the
 * shared `LedgerSource` contract because nothing else reads them off a
 * source record.
 */
export interface ControlEvidence extends LedgerSource {
  runId?: number;
  label?: string;
  /** Set only by main.mjs's healStaleAgentLabels: the stale label(s) a
   *  dual-label self-heal removed. */
  labels?: string[];
}

function recordControlEvidence(
  ledger: DispatchLedger,
  evidence: ControlEvidence,
  now: string = new Date().toISOString(),
): { outcome: 'duplicate' | 'recorded'; ledger: DispatchLedger } {
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
  ledger: DispatchLedger,
  kind: string,
  detail: unknown,
  now: string = new Date().toISOString(),
  failure?: FailureClassification,
): DispatchLedger {
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
  abandonPendingLaunchForClosedAnchor,
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
  recordOutcome,
  renderLedgerComment,
  restoreAcceptedForLaunchRetry,
  validateIntent,
  validateLedger,
  verifyPreflight,
};
