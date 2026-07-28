import { TokenUsage } from './types';

/** Claude's five-minute prompt-cache price relative to a fresh input token.
 * @see https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing
 */
const CLAUDE_CACHE_CREATION_COST_WEIGHT = 1.25;

/** Claude's prompt-cache read price relative to a fresh input token.
 * @see https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing
 */
const CLAUDE_CACHE_READ_COST_WEIGHT = 0.1;

/**
 * Cost-weighted token equivalent for a session. Fresh input and output keep
 * their recorded token counts; Claude cache writes and reads are weighted by
 * their five-minute prompt-cache price relative to fresh input (1.25x and
 * 0.1x). This keeps cache traffic visible without letting repeated cache
 * reads dominate a token-based cost proxy.
 *
 * The source transcript does not record cache TTL, so a cache creation uses
 * the standard five-minute rate rather than guessing a one-hour rate.
 */
export function totalTokens(tokens: TokenUsage): number {
  return Math.round(
    tokens.inputTokens +
      tokens.outputTokens +
      tokens.cacheCreationTokens * CLAUDE_CACHE_CREATION_COST_WEIGHT +
      tokens.cacheReadTokens * CLAUDE_CACHE_READ_COST_WEIGHT,
  );
}

interface ModelRates {
  inputPerMillion: number;
  /** 5-minute prompt-cache write rate. TokenUsage doesn't record cache TTL,
   * so (like {@link totalTokens}'s own weighting) this is the only cache
   * write rate this module can price. */
  cacheWritePerMillion: number;
  /** Prompt-cache read (hit) rate. */
  cacheReadPerMillion: number;
  outputPerMillion: number;
}

/**
 * Published Claude API per-million-token USD rates, keyed by the model-id
 * *prefix* that names a family+version regardless of its dated snapshot
 * suffix — e.g. `'claude-opus-4-1'` matches both the bare alias and the
 * pinned `'claude-opus-4-1-20250805'`. See {@link resolveModelRates} for the
 * matching rule; no key here is a prefix of another, so which one matches a
 * given model id is never ambiguous.
 *
 * Retired-except-Bedrock/Google-Cloud model generations (Claude Opus 4,
 * Sonnet 4, Haiku 3.5 and earlier) are intentionally omitted — this repo's
 * sessions only ever run the first-party Claude API, so a session predating
 * this table would already have no confirmed model-id string to key off of.
 *
 * @see https://platform.claude.com/docs/en/about-claude/pricing#model-pricing
 * @see https://platform.claude.com/docs/en/about-claude/models/overview
 */
const MODEL_RATES: Record<string, ModelRates> = {
  'claude-fable-5': {
    inputPerMillion: 10,
    cacheWritePerMillion: 12.5,
    cacheReadPerMillion: 1,
    outputPerMillion: 50,
  },
  'claude-mythos-5': {
    inputPerMillion: 10,
    cacheWritePerMillion: 12.5,
    cacheReadPerMillion: 1,
    outputPerMillion: 50,
  },
  'claude-opus-5': {
    inputPerMillion: 5,
    cacheWritePerMillion: 6.25,
    cacheReadPerMillion: 0.5,
    outputPerMillion: 25,
  },
  'claude-opus-4-8': {
    inputPerMillion: 5,
    cacheWritePerMillion: 6.25,
    cacheReadPerMillion: 0.5,
    outputPerMillion: 25,
  },
  'claude-opus-4-7': {
    inputPerMillion: 5,
    cacheWritePerMillion: 6.25,
    cacheReadPerMillion: 0.5,
    outputPerMillion: 25,
  },
  'claude-opus-4-6': {
    inputPerMillion: 5,
    cacheWritePerMillion: 6.25,
    cacheReadPerMillion: 0.5,
    outputPerMillion: 25,
  },
  'claude-opus-4-5': {
    inputPerMillion: 5,
    cacheWritePerMillion: 6.25,
    cacheReadPerMillion: 0.5,
    outputPerMillion: 25,
  },
  'claude-opus-4-1': {
    inputPerMillion: 15,
    cacheWritePerMillion: 18.75,
    cacheReadPerMillion: 1.5,
    outputPerMillion: 75,
  },
  // Introductory pricing, in effect through 2026-08-31 (see the pricing
  // doc's "claude-sonnet-5-introductory-pricing" note) — reverts to the
  // standard $3/$15 (matching claude-sonnet-4-5/4-6) on 2026-09-01. Update
  // this entry once that date passes.
  'claude-sonnet-5': {
    inputPerMillion: 2,
    cacheWritePerMillion: 2.5,
    cacheReadPerMillion: 0.2,
    outputPerMillion: 10,
  },
  'claude-sonnet-4-6': {
    inputPerMillion: 3,
    cacheWritePerMillion: 3.75,
    cacheReadPerMillion: 0.3,
    outputPerMillion: 15,
  },
  'claude-sonnet-4-5': {
    inputPerMillion: 3,
    cacheWritePerMillion: 3.75,
    cacheReadPerMillion: 0.3,
    outputPerMillion: 15,
  },
  'claude-haiku-4-5': {
    inputPerMillion: 1,
    cacheWritePerMillion: 1.25,
    cacheReadPerMillion: 0.1,
    outputPerMillion: 5,
  },
};

/** Longest-prefix match of `model` against {@link MODEL_RATES}'s keys, so a
 * dated snapshot id resolves to the same rate card as its bare alias. */
function resolveModelRates(model: string): ModelRates | undefined {
  let best: ModelRates | undefined;
  let bestPrefixLength = -1;
  for (const [prefix, rates] of Object.entries(MODEL_RATES)) {
    if (prefix.length > bestPrefixLength && model.startsWith(prefix)) {
      best = rates;
      bestPrefixLength = prefix.length;
    }
  }
  return best;
}

/**
 * Estimated USD cost of a session's token usage, from published Claude API
 * market rates (see {@link MODEL_RATES}) — the cost ledger's fallback for a
 * session whose transcript never reported a real `costUSD` line (see
 * reducer.ts's `applyLine`), which is the norm for an OAuth/subscription-
 * billed run rather than an API-key-metered one. Cache creation is priced
 * at the 5-minute write rate, the same simplification {@link totalTokens}
 * already makes, since `TokenUsage` doesn't track cache TTL.
 *
 * Returns `undefined` when `model` is absent or names a model this table
 * has no rate for, so a session with genuinely unknown pricing stays
 * unmeasured rather than silently reporting $0.
 */
export function estimateCostUsd(
  model: string | undefined,
  tokens: TokenUsage,
): number | undefined {
  const rates = model && resolveModelRates(model);
  if (!rates) {
    return undefined;
  }
  return (
    (tokens.inputTokens * rates.inputPerMillion +
      tokens.outputTokens * rates.outputPerMillion +
      tokens.cacheCreationTokens * rates.cacheWritePerMillion +
      tokens.cacheReadTokens * rates.cacheReadPerMillion) /
    1_000_000
  );
}
