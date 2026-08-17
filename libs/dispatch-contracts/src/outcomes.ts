/**
 * Durable worker-result categories. These describe what happened in the
 * worker lifecycle; GitHub's run conclusion alone cannot distinguish a
 * bootstrap failure from a model trajectory failure, a false-negative
 * deliverable gate, or a useful protocol outcome.
 */
export type DispatchOutcomeKind =
  | 'startup-failure'
  | 'trajectory-failure'
  | 'outcome-gate-failure'
  | 'park'
  | 'no-op'
  | 'pull-request'
  | 'merged-deliverable'
  | 'review'
  | 'comment'
  | 'closed'
  | 'unknown-success';
