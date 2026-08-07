/**
 * The generation state machine (#645 Phase 2 extraction from broker.mjs):
 * `scheduling` and `launch`-adjacent transitions from an already-accepted
 * generation through dispatch, binding, completion observation, and terminal
 * outcome.
 *
 * Every function here is a pure ledger transition -- no GitHub I/O, no
 * fetch. main.mjs's dispatchAccepted()/reconcileActive()/handleCompletion()
 * call these and perform the actual GitHub Actions dispatch/poll calls
 * around them.
 *
 * Depends on broker.mjs for the ledger-core primitives (`mutate`,
 * `validateLedger`, `ACTIVE_STATES`) for the same reason modules/intent.mjs
 * does -- see the comment there.
 */

import { formatAttemptId } from '../../../../libs/dispatch-contracts/src/index.js';
import { ACTIVE_STATES, mutate, validateLedger } from './ledger-core.mjs';

const TERMINAL_RUN_STATUSES = new Set(['completed']);

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
    // `attemptId` is identity, `token` is proof, and they are deliberately
    // different things: the ID is public (it is the run title's marker) while
    // the token is the bearer capability preflight checks. Persisting the ID
    // rather than re-deriving it at each read is what makes it immutable --
    // a later reader sees the value written here, not one recomputed from
    // fields that a repair could in principle touch.
    generation.attempt = {
      attemptId: formatAttemptId(generation),
      token,
      dispatchStartedAt: now,
    };
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

export {
  awaitTerminal,
  beginDispatch,
  bindRun,
  completeRun,
  markDispatchRejected,
  markDispatchUnknown,
  observeCompletion,
  verifyPreflight,
};
