/**
 * Durable worker-result categories. These describe what happened in the
 * worker lifecycle; GitHub's run conclusion alone cannot distinguish a
 * bootstrap failure from a model trajectory failure, a false-negative
 * deliverable gate, or a useful protocol outcome.
 */
export const DISPATCH_OUTCOME_KINDS = [
  'startup-failure',
  'trajectory-failure',
  'outcome-gate-failure',
  'park',
  'no-op',
  'pull-request',
  'merged-deliverable',
  'review',
  'comment',
  'closed',
  'unknown-success',
] as const;

export type DispatchOutcomeKind = (typeof DISPATCH_OUTCOME_KINDS)[number];

/** Exact GitHub object that backs a worker-reported outcome. The first
 * rollout only needs pull requests: comments/reviews already remain useful
 * terminal categories on their own, while a PR is the one deliverable whose
 * state can later advance from "produced" to "merged". Keeping the number
 * beside the immutable worker result lets readers make that later join
 * without guessing from timestamps, bot identities, or unrelated closing
 * references on a long-lived issue. */
export interface DispatchOutcomeReference {
  kind: 'pull-request';
  number: number;
}

export function isDispatchOutcomeKind(
  value: unknown,
): value is DispatchOutcomeKind {
  return DISPATCH_OUTCOME_KINDS.includes(value as DispatchOutcomeKind);
}

export function isDispatchOutcomeReference(
  value: unknown,
): value is DispatchOutcomeReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === 'pull-request' &&
    Number.isSafeInteger(candidate.number) &&
    Number(candidate.number) > 0
  );
}
