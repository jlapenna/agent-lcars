import { estimateCostUsd, totalTokens } from './tokens';
import type { SessionDoc, SessionWrite } from './types';

/** A single session's cost contribution to the ledger: its recorded
 * `totalCostUsd` when present, else an {@link estimateCostUsd} from its
 * model + token usage, else no cost at all - see `sessionCost`. */
export interface SessionCost {
  costUsd: number | undefined;
  /** True when `costUsd` came from `estimateCostUsd` rather than a recorded
   * `totalCostUsd`. Meaningless when `costUsd` is undefined. */
  estimated: boolean;
}

/**
 * Resolves a session doc's cost contribution: its own recorded
 * `totalCostUsd` when the transcript reported one, otherwise a published-
 * rate estimate from its `model` + `tokens` (undefined when the model is
 * absent or unrecognized - see {@link estimateCostUsd}'s doc comment for
 * why that's the right fallback rather than treating it as a $0 session).
 * Floors a recorded cost at $0 - reducer.ts now clamps newly-ingested
 * sessions the same way, but a doc written before that fix can still carry
 * a stored negative total, which would otherwise drag a bucket's summed
 * total below what its other, correctly-priced sessions actually cost.
 */
export function sessionCost(
  doc: Pick<SessionDoc, 'totalCostUsd' | 'model' | 'resolvedModel' | 'tokens'>,
): SessionCost {
  if (doc.totalCostUsd !== undefined && Number.isFinite(doc.totalCostUsd)) {
    return { costUsd: Math.max(0, doc.totalCostUsd), estimated: false };
  }
  return {
    costUsd: estimateCostUsd(doc.resolvedModel ?? doc.model, doc.tokens),
    estimated: true,
  };
}

/**
 * Derives the indexed fields from the session as it will look after the
 * writer's merge. Omitted model and reported cost fields retain their
 * stored values. An explicit resolvedModel deletion takes precedence.
 */
export function sessionSpendForWrite(
  { doc, clearFields }: SessionWrite,
  stored: Record<string, unknown> | undefined,
): NonNullable<SessionDoc['spend']> {
  const storedModel = stored?.['model'];
  const storedResolvedModel = stored?.['resolvedModel'];
  const storedCost = stored?.['totalCostUsd'];
  const cost = sessionCost({
    tokens: doc.tokens,
    model:
      doc.model ?? (typeof storedModel === 'string' ? storedModel : undefined),
    resolvedModel: clearFields.includes('resolvedModel')
      ? undefined
      : (doc.resolvedModel ??
        (typeof storedResolvedModel === 'string'
          ? storedResolvedModel
          : undefined)),
    totalCostUsd:
      doc.totalCostUsd ??
      (typeof storedCost === 'number' ? storedCost : undefined),
  });
  return { tokens: totalTokens(doc.tokens), costUsd: cost.costUsd ?? 0 };
}
