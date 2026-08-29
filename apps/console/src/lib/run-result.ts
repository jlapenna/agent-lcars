import { type RunResult } from '@agent-lcars/orchestrator';
import { z } from 'zod';

const OK_OUTCOMES: ReadonlySet<string> = new Set([
  'pull-request',
  'merged-deliverable',
  'comment',
  'review',
  'no-op',
  'park',
  'unknown-success',
]);

const pullRequestOutcomeReferenceSchema = z.object({
  kind: z.literal('pull-request'),
  number: z.number(),
});

/** Converts the QueueExecutor's Work API completion report into the durable
 * run result. The `runs-router` contract test exercises the public
 * `/runs/{runId}/complete` boundary, including its result and item state. */
export function toRunResult(
  repo: string,
  outcome: unknown,
  outcomeReference: unknown,
): RunResult {
  const summary = typeof outcome === 'string' ? outcome : undefined;
  const parsedRef =
    pullRequestOutcomeReferenceSchema.safeParse(outcomeReference);
  return {
    ok: typeof outcome === 'string' && OK_OUTCOMES.has(outcome),
    ...(summary === undefined ? {} : { summary }),
    ...(parsedRef.success
      ? { ref: `https://github.com/${repo}/pull/${parsedRef.data.number}` }
      : {}),
  };
}
