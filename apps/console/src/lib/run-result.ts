import { type RunResult } from '@agent-lcars/orchestrator';
import { outcomeReferenceSchema } from '@agent-lcars/work';

const OK_OUTCOMES: ReadonlySet<string> = new Set([
  'pull-request',
  'merged-deliverable',
  'comment',
  'review',
  'no-op',
  'park',
  'unknown-success',
]);

type ArtifactReference = ReturnType<typeof outcomeReferenceSchema.parse>;
interface ReferenceContext {
  /** Immutable GitHub anchor, absent for native work. */
  issue?: number;
  mode?: string;
}

/** Restrict REST-sourced permalinks to this repository, anchor and artifact.
 * http(s) alone is not evidence that a URL identifies the verified comment. */
function artifactUrl(
  repo: string,
  reference: ArtifactReference,
  context?: ReferenceContext,
): string | undefined {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repo)) return undefined;
  if (reference.kind === 'pull-request') {
    return `https://github.com/${repo}/pull/${reference.number}`;
  }
  if (
    context?.issue !== reference.number ||
    (reference.kind === 'review' && context?.mode !== 'review')
  )
    return undefined;
  const bases = reference.kind === 'comment' ? ['issues', 'pull'] : ['pull'];
  const fragment =
    reference.kind === 'comment' ? 'issuecomment' : 'pullrequestreview';
  return bases.some(
    (base) =>
      reference.url ===
      `https://github.com/${repo}/${base}/${reference.number}#${fragment}-${reference.id}`,
  )
    ? reference.url
    : undefined;
}

/** Converts the QueueExecutor's Work API completion report into the durable
 * run result. The `runs-router` contract test exercises the public
 * `/runs/{runId}/complete` boundary, including its result and item state. */
export function toRunResult(
  repo: string,
  outcome: unknown,
  outcomeReference: unknown,
  message?: unknown,
  context?: ReferenceContext,
): RunResult {
  const summary = typeof outcome === 'string' ? outcome : undefined;
  const parsedRef = outcomeReferenceSchema.safeParse(outcomeReference);
  const ref =
    parsedRef.success && typeof outcome === 'string' && OK_OUTCOMES.has(outcome)
      ? artifactUrl(repo, parsedRef.data, context)
      : undefined;
  const relatedRefs =
    parsedRef.success && ref !== undefined
      ? parsedRef.data.related?.flatMap((reference) => {
          const url = artifactUrl(repo, reference, context);
          return url === undefined || url === ref ? [] : [url];
        })
      : undefined;
  // A runner that sends no message, or a malformed one, is not an error:
  // the round is still a real outcome, it just has no rendered turn.
  const finalMessage =
    typeof message === 'string' && message.length > 0
      ? message.slice(0, 16_384)
      : undefined;
  return {
    ok: typeof outcome === 'string' && OK_OUTCOMES.has(outcome),
    ...(summary === undefined ? {} : { summary }),
    ...(ref === undefined ? {} : { ref }),
    ...(relatedRefs === undefined || relatedRefs.length === 0
      ? {}
      : { relatedRefs }),
    ...(finalMessage === undefined ? {} : { message: finalMessage }),
  };
}
