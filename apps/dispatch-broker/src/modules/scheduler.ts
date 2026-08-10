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

import type {
  DispatchLedger,
  DispatchOutcomeKind,
  DispatchOutcomeReference,
  LedgerGeneration,
  LedgerRunAttempt,
  LedgerTaskRef,
} from '@agent-lcars/dispatch-contracts';
import { formatAttemptId } from '@agent-lcars/dispatch-contracts';

import { ACTIVE_STATES, mutate, validateLedger } from './ledger-core';

const TERMINAL_RUN_STATUSES = new Set(['completed']);

/** What `bindRun` needs to know about the workflow run it is binding to a
 *  generation. `workflow` is carried through unchanged but is not part of
 *  `LedgerRunAttempt` -- see the comment on `Object.assign` below. */
interface RunBinding {
  runId: number;
  runUrl: string;
  htmlUrl: string;
  workflow?: string;
}

function recordOutcome(
  ledger: DispatchLedger,
  generationNumber: number,
  outcome: DispatchOutcomeKind,
  outcomeReference?: DispatchOutcomeReference,
  now: string = new Date().toISOString(),
): DispatchLedger {
  const generation = findGeneration(ledger, generationNumber);
  if (
    !generation ||
    ![
      'active',
      'completion-observed',
      'completion-awaiting-terminal',
      'completed',
    ].includes(generation.state)
  ) {
    throw new Error('Generation is not awaiting a worker outcome');
  }
  const attempt = attemptOf(generation);
  if (attempt.outcome && attempt.outcome !== outcome) {
    throw new Error(
      `Generation ${generationNumber} already reported outcome ${attempt.outcome}, not ${outcome}`,
    );
  }
  if (
    outcomeReference &&
    attempt.outcomeReference &&
    JSON.stringify(attempt.outcomeReference) !==
      JSON.stringify(outcomeReference)
  ) {
    throw new Error(
      `Generation ${generationNumber} already reported a different outcome reference`,
    );
  }
  if (
    attempt.outcome === outcome &&
    (!outcomeReference || attempt.outcomeReference)
  ) {
    return ledger;
  }
  return mutate(ledger, now, () => {
    attempt.outcome = outcome;
    if (outcomeReference) attempt.outcomeReference = outcomeReference;
  });
}

/** What `completeRun` needs from a terminal run observation. */
interface RunObservation {
  runId: number;
  status: string;
  conclusion: string | null;
  completedAt?: string;
}

/** `verifyPreflight`'s expected binding -- what a worker's own preflight
 *  step claims about the run it is executing as, checked against the
 *  ledger's authoritative state. See main.mjs's `preflight()`. */
export interface PreflightExpectation {
  task: LedgerTaskRef;
  generation: number;
  intentId: string;
  token: string;
  runId: number;
}

function findGeneration(
  ledger: DispatchLedger,
  generationNumber: number,
): LedgerGeneration | undefined {
  return ledger.generations.find(
    (candidate) => candidate.generation === generationNumber,
  );
}

/** The generation states these transitions accept all guarantee an attempt
 * exists; this makes that invariant explicit and fails loudly if it is ever
 * violated, rather than dereferencing undefined and blaming the caller. */
function attemptOf(generation: LedgerGeneration): LedgerRunAttempt {
  const { attempt } = generation;
  if (!attempt) {
    throw new Error(`Generation ${generation.generation} has no attempt`);
  }
  return attempt;
}

function canDispatchOnAnchor(ledger: DispatchLedger): boolean {
  return !ledger.control.closed;
}

function beginDispatch(
  ledger: DispatchLedger,
  generationNumber: number,
  token: string,
  now: string = new Date().toISOString(),
): DispatchLedger {
  const generation = findGeneration(ledger, generationNumber);
  if (!generation || !['accepted', 'pending'].includes(generation.state)) {
    throw new Error('Generation is not dispatchable');
  }
  if (!canDispatchOnAnchor(ledger)) {
    throw new Error('Closed anchor cannot dispatch');
  }
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
  ledger: DispatchLedger,
  generationNumber: number,
  reason: string,
  now: string = new Date().toISOString(),
): DispatchLedger {
  const generation = findGeneration(ledger, generationNumber);
  if (!generation || generation.state !== 'dispatching') {
    throw new Error('Generation is not dispatching');
  }
  return mutate(ledger, now, () => {
    generation.state = 'dispatch-unknown';
    // `attempt` is guaranteed set: the `dispatching` state above is only
    // ever reached via beginDispatch(), which always sets it in the same
    // mutate() before advancing the generation into that state.
    const attempt = attemptOf(generation);
    attempt.unknownAt = now;
    attempt.unknownReason = reason;
  });
}

function markDispatchRejected(
  ledger: DispatchLedger,
  generationNumber: number,
  reason: string,
  now: string = new Date().toISOString(),
): { ledger: DispatchLedger; promotedGeneration?: number } {
  const generation = findGeneration(ledger, generationNumber);
  if (!generation || generation.state !== 'dispatching') {
    throw new Error('Generation is not dispatching');
  }
  let promoted: LedgerGeneration | undefined;
  mutate(ledger, now, () => {
    generation.state = 'dispatch-rejected';
    // Same guarantee as markDispatchUnknown above.
    const attempt = attemptOf(generation);
    attempt.rejectedAt = now;
    attempt.rejectionReason = reason;
    promoted = ledger.generations.find(
      (candidate) =>
        candidate.state === 'pending' && canDispatchOnAnchor(ledger),
    );
    if (promoted) promoted.state = 'accepted';
  });
  return { ledger, promotedGeneration: promoted?.generation };
}

/**
 * Return a launch whose durable outbox intent is still pending to the
 * dispatchable state after reconciliation has exhausted its bounded search
 * for a matching real-world run. The attempt marker remains stable because
 * it is derived from immutable generation identity; beginDispatch will mint
 * a fresh bearer token for the retried worker preflight.
 */
function restoreAcceptedForLaunchRetry(
  ledger: DispatchLedger,
  generationNumber: number,
  now: string = new Date().toISOString(),
): DispatchLedger {
  const generation = findGeneration(ledger, generationNumber);
  if (
    !generation ||
    !['dispatching', 'dispatch-unknown'].includes(generation.state) ||
    generation.attempt?.runId
  ) {
    throw new Error('Generation is not an unbound launch attempt');
  }
  if (ledger.control.closed) {
    throw new Error('Closed anchor cannot retry a launch');
  }
  return mutate(ledger, now, () => {
    generation.state = 'accepted';
    generation.attempt = undefined;
  });
}

function abandonPendingLaunchForClosedAnchor(
  ledger: DispatchLedger,
  generationNumber: number,
  reason: string,
  now: string = new Date().toISOString(),
): DispatchLedger {
  const generation = findGeneration(ledger, generationNumber);
  if (
    !generation ||
    !['dispatching', 'dispatch-unknown'].includes(generation.state) ||
    generation.attempt?.runId
  ) {
    throw new Error('Generation is not an unbound launch attempt');
  }
  if (!ledger.control.closed) {
    throw new Error('Open anchor cannot abandon a pending launch');
  }
  return mutate(ledger, now, () => {
    generation.state = 'superseded-by-close';
    const attempt = attemptOf(generation);
    attempt.rejectedAt = now;
    attempt.rejectionReason = reason;
  });
}

function bindRun(
  ledger: DispatchLedger,
  generationNumber: number,
  binding: RunBinding,
  now: string = new Date().toISOString(),
): DispatchLedger {
  const generation = findGeneration(ledger, generationNumber);
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
    // Same attempt-is-set guarantee as markDispatchUnknown above. `binding`
    // carries `workflow`, which is not part of `LedgerRunAttempt` -- it
    // lands on the attempt object the same as it always has, unchanged.
    Object.assign(attemptOf(generation), binding, { boundAt: now });
  });
}

function observeCompletion(
  ledger: DispatchLedger,
  generationNumber: number,
  runId: number,
  now: string = new Date().toISOString(),
): DispatchLedger {
  const generation = findGeneration(ledger, generationNumber);
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
    attemptOf(generation).completionObservedAt ??= now;
  });
}

function awaitTerminal(
  ledger: DispatchLedger,
  generationNumber: number,
  now: string = new Date().toISOString(),
): DispatchLedger {
  const generation = findGeneration(ledger, generationNumber);
  if (!generation || generation.state !== 'completion-observed') {
    throw new Error('Completion has not been observed');
  }
  return mutate(ledger, now, () => {
    generation.state = 'completion-awaiting-terminal';
    attemptOf(generation).lastObservedAt = now;
  });
}

function completeRun(
  ledger: DispatchLedger,
  generationNumber: number,
  observation: RunObservation,
  now: string = new Date().toISOString(),
): { ledger: DispatchLedger; promotedGeneration?: number } {
  const generation = findGeneration(ledger, generationNumber);
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
  // Narrowed once here rather than re-read inside the closure below: a
  // `typeof` check on a parameter does not survive into a callback defined
  // afterward, so re-reading `observation.conclusion` there would still see
  // the wider `string | null` this same check already ruled out.
  const conclusion = observation.conclusion;
  let promoted: LedgerGeneration | undefined;
  mutate(ledger, now, () => {
    generation.state = 'completed';
    const attempt = attemptOf(generation);
    attempt.status = observation.status;
    attempt.conclusion = conclusion;
    attempt.completedAt = observation.completedAt ?? now;
    promoted = ledger.generations.find(
      (candidate) =>
        candidate.state === 'pending' && canDispatchOnAnchor(ledger),
    );
    if (promoted) promoted.state = 'accepted';
  });
  return { ledger, promotedGeneration: promoted?.generation };
}

function verifyPreflight(
  ledger: DispatchLedger,
  expected: PreflightExpectation,
): boolean {
  validateLedger(ledger, expected.task);
  const generation = findGeneration(ledger, expected.generation);
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
};
