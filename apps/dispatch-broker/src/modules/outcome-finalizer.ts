/**
 * Pure execution-outcome reconciliation for one dispatched attempt.
 *
 * This module deliberately has no GitHub client, ledger writer, admission
 * service, or scheduler capability. It classifies observed execution facts;
 * the controller remains responsible for applying the returned decision.
 */

export const MISSING_RUN_GRACE_MS = 5 * 60 * 1000;
export const MISSING_RUN_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const MISSING_RUN_MAX_OBSERVATIONS = 3;
export const STUCK_RUN_GRACE_MS = 4 * 60 * 60 * 1000;
export const STUCK_RUN_MIN_INTERVAL_MS = 30 * 60 * 1000;
export const STUCK_RUN_MAX_OBSERVATIONS = 3;

export type ExecutionState =
  'not_started' | 'running' | 'exited' | 'timed_out' | 'cancelled' | 'lost';

export interface FinalizerAttempt {
  dispatchStartedAt: string;
  boundAt?: string;
  runId?: number;
}

export interface FinalizerRunObservation {
  status: string;
  conclusion?: string | null;
  updatedAt?: string;
}

export interface PriorObservation {
  occurredAt: string;
}

export type ExecutionDecision =
  | { state: 'not_started' | 'running'; action: 'wait'; ageMs: number }
  | {
      state: 'not_started' | 'running';
      action: 'observe';
      ageMs: number;
      observation: number;
      retryBudget: number;
    }
  | {
      state: 'exited' | 'timed_out' | 'cancelled';
      action: 'finalize';
    }
  | {
      state: 'lost';
      action: 'escalate';
      ageMs: number;
      observation: number;
      retryBudget: 0;
      cause: 'run_missing' | 'run_stuck';
    };

export interface ReconcileExecutionInput {
  attempt: FinalizerAttempt;
  run?: FinalizerRunObservation;
  now: string;
  priorObservations: readonly PriorObservation[];
}

function terminalState(
  conclusion: string | null | undefined,
): 'exited' | 'timed_out' | 'cancelled' {
  if (conclusion === 'timed_out') return 'timed_out';
  if (conclusion === 'cancelled') return 'cancelled';
  return 'exited';
}

export function reconcileExecution(
  input: ReconcileExecutionInput,
): ExecutionDecision {
  if (input.run?.status === 'completed') {
    return { state: terminalState(input.run.conclusion), action: 'finalize' };
  }

  const bound = input.attempt.runId !== undefined;
  const state = bound ? 'running' : 'not_started';
  const baseline = bound
    ? (input.attempt.boundAt ?? input.attempt.dispatchStartedAt)
    : input.attempt.dispatchStartedAt;
  const ageMs = Date.parse(input.now) - Date.parse(baseline);
  const graceMs = bound ? STUCK_RUN_GRACE_MS : MISSING_RUN_GRACE_MS;
  if (!(ageMs >= graceMs)) return { state, action: 'wait', ageMs };

  const minIntervalMs = bound
    ? STUCK_RUN_MIN_INTERVAL_MS
    : MISSING_RUN_MIN_INTERVAL_MS;
  const last = input.priorObservations.at(-1);
  if (
    last &&
    Date.parse(input.now) - Date.parse(last.occurredAt) < minIntervalMs
  ) {
    return { state, action: 'wait', ageMs };
  }

  const observation = input.priorObservations.length + 1;
  const maxObservations = bound
    ? STUCK_RUN_MAX_OBSERVATIONS
    : MISSING_RUN_MAX_OBSERVATIONS;
  const retryBudget = Math.max(0, maxObservations - observation);
  if (observation >= maxObservations) {
    return {
      state: 'lost',
      action: 'escalate',
      ageMs,
      observation,
      retryBudget: 0,
      cause: bound ? 'run_stuck' : 'run_missing',
    };
  }
  return { state, action: 'observe', ageMs, observation, retryBudget };
}
