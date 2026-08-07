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

import { isDispatchPipeline } from '../../../../libs/dispatch-contracts/src/index.js';
import {
  ACTIVE_STATES,
  assertTaskRef,
  mutate,
  validateLedger,
} from './ledger-core.mjs';

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

export { acceptIntent, compareIntentOrder, validateIntent };
