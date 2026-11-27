import { estimateCostUsd, totalTokens } from './tokens';
import type { SessionDoc, SessionWrite, TokenUsage } from './types';

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
  return sessionSpend({
    tokens: doc.tokens,
    model: doc.model ?? storedString(stored, 'model'),
    resolvedModel: clearFields.includes('resolvedModel')
      ? undefined
      : (doc.resolvedModel ?? storedString(stored, 'resolvedModel')),
    totalCostUsd: doc.totalCostUsd ?? storedNumber(stored, 'totalCostUsd'),
  });
}

function storedString(
  stored: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = stored?.[field];
  return typeof value === 'string' ? value : undefined;
}

function storedNumber(
  stored: Record<string, unknown> | undefined,
  field: string,
): number | undefined {
  const value = stored?.[field];
  return typeof value === 'number' ? value : undefined;
}

/** The one derivation of the indexed spend fields: pricing inputs in,
 * materialized `spend` out. Writers use it through {@link sessionSpendForWrite}
 * and the backfill through {@link sessionSpendFromStored}, so a stored doc and
 * the same doc re-derived later can never disagree by construction. */
function sessionSpend(
  doc: Pick<SessionDoc, 'totalCostUsd' | 'model' | 'resolvedModel' | 'tokens'>,
): NonNullable<SessionDoc['spend']> {
  const cost = sessionCost(doc);
  return { tokens: totalTokens(doc.tokens), costUsd: cost.costUsd ?? 0 };
}

/** The stored fields the spend derivation reads, as the sessions spend backfill
 * (`backfillSessionSpend` in the server store) selects them. `tokens` is the
 * persisted {@link TokenUsage} map; a doc written by an older writer may carry
 * none. */
export interface StoredSessionSpendInputs {
  tokens: TokenUsage | undefined;
  model: string | undefined;
  resolvedModel: string | undefined;
  totalCostUsd: number | undefined;
}

/** A persisted `tokens` map only counts when every member is a finite number:
 * {@link totalTokens} does no coercion, so a partially-written map would
 * otherwise materialize `NaN` into an indexed sum. */
export function storedTokenUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const stored = value as Record<string, unknown>;
  const usage: TokenUsage = {
    inputTokens: stored['inputTokens'] as number,
    outputTokens: stored['outputTokens'] as number,
    cacheCreationTokens: stored['cacheCreationTokens'] as number,
    cacheReadTokens: stored['cacheReadTokens'] as number,
  };
  return Object.values(usage).every(
    (count) => typeof count === 'number' && Number.isFinite(count),
  )
    ? usage
    : undefined;
}

/**
 * Re-derives `spend` from a stored session document's own pricing inputs, for
 * the backfill that brings docs written before #3641 (or by a writer from an
 * older runner image) up to the materialized contract. A doc with no complete
 * `tokens` map yields `undefined` rather than zeros: writing zeros for a doc
 * whose usage was never read would report a real session as free, so the
 * backfill leaves it alone and counts it.
 */
export function sessionSpendFromStored(
  stored: StoredSessionSpendInputs,
): NonNullable<SessionDoc['spend']> | undefined {
  if (stored.tokens === undefined) {
    return undefined;
  }
  return sessionSpend({
    tokens: stored.tokens,
    model: stored.model,
    resolvedModel: stored.resolvedModel,
    totalCostUsd: stored.totalCostUsd,
  });
}
