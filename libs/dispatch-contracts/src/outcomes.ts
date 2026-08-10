/**
 * Durable worker-result categories. These describe what happened in the
 * worker lifecycle; GitHub's run conclusion alone cannot distinguish a
 * bootstrap failure from a model trajectory failure, a false-negative
 * deliverable gate, or a useful protocol outcome.
 */
import { z } from 'zod';

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

export const dispatchOutcomeKindSchema = z.enum(DISPATCH_OUTCOME_KINDS);
export type DispatchOutcomeKind = z.infer<typeof dispatchOutcomeKindSchema>;

/** Exact GitHub object that backs a worker-reported outcome. The first
 * rollout only needs pull requests: comments/reviews already remain useful
 * terminal categories on their own, while a PR is the one deliverable whose
 * state can later advance from "produced" to "merged". Keeping the number
 * beside the immutable worker result lets readers make that later join
 * without guessing from timestamps, bot identities, or unrelated closing
 * references on a long-lived issue. */
export const dispatchOutcomeReferenceSchema = z.looseObject({
  kind: z.literal('pull-request'),
  number: z.number().int().safe().positive(),
});
export type DispatchOutcomeReference = z.infer<
  typeof dispatchOutcomeReferenceSchema
>;

export function isDispatchOutcomeKind(
  value: unknown,
): value is DispatchOutcomeKind {
  return dispatchOutcomeKindSchema.safeParse(value).success;
}

export function isDispatchOutcomeReference(
  value: unknown,
): value is DispatchOutcomeReference {
  return dispatchOutcomeReferenceSchema.safeParse(value).success;
}
