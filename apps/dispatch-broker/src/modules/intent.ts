/**
 * Intent acceptance, dedup, and ordering/supersession (#645 Phase 2
 * extraction from broker.mjs).
 *
 * This is the controller's `intent` phase: given an already-authorized,
 * already-normalized DispatchIntent, decide whether it becomes the ledger's
 * new desired generation, a semantic duplicate of one that already exists, a
 * pending successor queued behind the current active generation, or stale
 * against a newer intent that already superseded it.
 *
 * Depends on broker.mjs for the ledger-core primitives (`mutate`,
 * `validateLedger`, `assertTaskRef`, `ACTIVE_STATES`) rather than
 * duplicating them -- those are ledger-wide invariants, not intent-specific
 * logic, and broker.mjs remains their one definition. broker.mjs, in turn,
 * imports this module's exports back to re-export them under its own
 * historical names; see the comment on that import in broker.mjs for why
 * that shape (rather than each side owning disjoint state) is safe.
 */

import type {
  DispatchLedger,
  DispatchPipeline,
  LedgerAuthorizationDecision,
  LedgerGeneration,
  LedgerSource,
  LedgerTaskRef,
} from '@agent-lcars/dispatch-contracts';
import { isDispatchPipeline } from '@agent-lcars/dispatch-contracts';

import {
  ACTIVE_STATES,
  assertTaskRef,
  mutate,
  validateLedger,
} from './ledger-core';

/**
 * A normalized, already-authorized dispatch signal -- normalize.mjs's
 * `makeIntent()` output, and what `acceptIntent()` below turns into a ledger
 * generation (or recognizes as a duplicate of one). `intentId`/`digest` are
 * always populated by `makeIntent()` itself, regardless of which event kind
 * produced the rest of the fields; every other field is common to every
 * `makeIntent()` call site across normalize.mjs and main.mjs.
 */
export interface Intent {
  task: LedgerTaskRef;
  sourceKind: string;
  sourceId: string;
  transportRunId: number;
  occurredAt: string;
  pipeline: DispatchPipeline;
  mode: string;
  reply: string;
  runbook: string;
  context: string;
  authorization: LedgerAuthorizationDecision;
  intentId: string;
  digest: string;
  /** Set only by normalize.mjs's `labeled` branch: whether this label event
   *  still reflects the issue's live agent:* / review:* selection, or has
   *  already been superseded by a later relabel. */
  dispatchable?: boolean;
  /** Set only by normalize.mjs's labeled-event self-heal (#304 audit item
   *  4): the other same-namespace label(s) a disambiguated relabel leaves
   *  stale on the issue. */
  staleAgentLabels?: string[];
}

/** The two fields `compareIntentOrder` actually needs -- it is called with
 *  an `Intent` on one side and a `LedgerGeneration` on the other, and both
 *  shapes carry these. */
interface Orderable {
  occurredAt: string;
  sourceId: string;
}

function compareIntentOrder(left: Orderable, right: Orderable): number {
  const byTime = left.occurredAt.localeCompare(right.occurredAt);
  return byTime || left.sourceId.localeCompare(right.sourceId);
}

function sourceEvidence(intent: Intent): LedgerSource {
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

function validateIntent(intent: Intent, task: LedgerTaskRef): void {
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

function generationForIntent(
  ledger: DispatchLedger,
  intentId: string,
): LedgerGeneration | undefined {
  return ledger.generations.find(
    (generation) => generation.intentId === intentId,
  );
}

/** Every outcome `acceptIntent()` can report. */
export type AcceptIntentOutcome =
  | 'duplicate'
  | 'semantic-duplicate'
  | 'dispatch'
  | 'pending'
  | 'stale'
  | 'stale-control-state'
  | 'closed';

export interface AcceptIntentResult {
  outcome: AcceptIntentOutcome;
  ledger: DispatchLedger;
  generation?: number;
}

function acceptIntent(
  ledger: DispatchLedger,
  intent: Intent,
  now: string = new Date().toISOString(),
): AcceptIntentResult {
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

  const generation: LedgerGeneration = {
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

  let outcome: AcceptIntentOutcome = 'dispatch';
  mutate(ledger, now, () => {
    ledger.sources.push(sourceEvidence(intent));
    ledger.generations.push(generation);
    if (intent.dispatchable === false) {
      generation.state = 'superseded';
      outcome = 'stale-control-state';
      return;
    }
    // The production canary reuses one canonical issue (#677), closing it
    // while healthy and reopening it only while a run is active or failed.
    // Its hardcoded no-op pipeline is therefore the sole intent allowed to
    // enter a closed anchor. Every human/agent pipeline retains the normal
    // fail-closed rule.
    if (ledger.control.closed && intent.pipeline !== 'canary') {
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

export { acceptIntent, compareIntentOrder, validateIntent };
