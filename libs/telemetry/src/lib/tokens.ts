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
 * Published first-party Claude, OpenAI (Codex), and Google Gemini (Antigravity)
 * API per-million-token USD rates, keyed by the model-id *prefix* that names a
 * family+version regardless of its dated snapshot or reasoning-effort suffix —
 * e.g. `'claude-opus-4-1'` matches `'claude-opus-4-1-20250805'` and
 * `'gemini-4-neon'` matches `'gemini-4-neon-high'`. See {@link resolveModelRates}
 * for the longest-prefix matching rule.
 *
 * Retired-except-Bedrock/Google-Cloud Claude generations (Claude Opus 4,
 * Sonnet 4, Haiku 3.5 and earlier) and local gateway aliases (`homelab/default`)
 * are intentionally omitted so sessions without a published first-party model
 * rate stay unmeasured (`undefined`) rather than reporting fabricated $0 spend.
 *
 * @see https://platform.claude.com/docs/en/about-claude/pricing#model-pricing
 * @see https://openai.com/api/pricing/
 * @see https://ai.google.dev/gemini-api/docs/pricing
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
  // Anthropic made the $2/$10 rate permanent for Claude Sonnet 5.
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
  // OpenAI GPT-6 / GPT-5.6 standard-tier API pricing (Codex CLI).
  // `codexAdapter` normalizes `inputTokens` to non-cached input and
  // `cacheReadTokens` to `cached_input_tokens`.
  'gpt-6.2-astra': {
    inputPerMillion: 8,
    cacheWritePerMillion: 10,
    cacheReadPerMillion: 0.4,
    outputPerMillion: 40,
  },
  'gpt-6-astra': {
    inputPerMillion: 10,
    cacheWritePerMillion: 12.5,
    cacheReadPerMillion: 1,
    outputPerMillion: 50,
  },
  'gpt-6.2-sol': {
    inputPerMillion: 2,
    cacheWritePerMillion: 2.5,
    cacheReadPerMillion: 0.1,
    outputPerMillion: 10,
  },
  'gpt-6.1-sol': {
    inputPerMillion: 2,
    cacheWritePerMillion: 2.5,
    cacheReadPerMillion: 0.1,
    outputPerMillion: 10,
  },
  'gpt-6-sol': {
    inputPerMillion: 2,
    cacheWritePerMillion: 2.5,
    cacheReadPerMillion: 0.1,
    outputPerMillion: 10,
  },
  'gpt-6.1-terra': {
    inputPerMillion: 1,
    cacheWritePerMillion: 1.25,
    cacheReadPerMillion: 0.05,
    outputPerMillion: 5,
  },
  'gpt-6-luna': {
    inputPerMillion: 0.1,
    cacheWritePerMillion: 0.125,
    cacheReadPerMillion: 0.01,
    outputPerMillion: 0.5,
  },
  'gpt-5.6-sol': {
    inputPerMillion: 4,
    cacheWritePerMillion: 4,
    cacheReadPerMillion: 0.4,
    outputPerMillion: 20,
  },
  'gpt-5.6-terra': {
    inputPerMillion: 2,
    cacheWritePerMillion: 2,
    cacheReadPerMillion: 0.2,
    outputPerMillion: 12,
  },
  'gpt-5.6-luna': {
    inputPerMillion: 0.2,
    cacheWritePerMillion: 0.2,
    cacheReadPerMillion: 0.02,
    outputPerMillion: 1.2,
  },
  // Google Gemini 4 standard-tier API pricing (Antigravity CLI).
  // Longest-prefix match resolves effort-suffixed ids (`gemini-4-neon-high`,
  // `gemini-4-argon-medium`, `gemini-4-carbon-medium`). Argon and Carbon carry
  // Google's introductory $2/$0.10/$10 rate through 2026-11-30 (scheduled to
  // move to $4/$0.20/$20 on 2026-12-01).
  'gemini-4-neon': {
    inputPerMillion: 3,
    cacheWritePerMillion: 3,
    cacheReadPerMillion: 0.15,
    outputPerMillion: 15,
  },
  'gemini-4-argon': {
    inputPerMillion: 2,
    cacheWritePerMillion: 2,
    cacheReadPerMillion: 0.1,
    outputPerMillion: 10,
  },
  'gemini-4-carbon': {
    inputPerMillion: 2,
    cacheWritePerMillion: 2,
    cacheReadPerMillion: 0.1,
    outputPerMillion: 10,
  },
  'gemini-4-hydrogen': {
    inputPerMillion: 1.5,
    cacheWritePerMillion: 1.5,
    cacheReadPerMillion: 0.075,
    outputPerMillion: 7.5,
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
 * Estimated USD cost of a session's token usage, from published first-party
 * model market rates (see {@link MODEL_RATES}) — the cost ledger's fallback for
 * a session whose transcript never reported a real `costUSD` line (see
 * reducer.ts's `applyLine`), which is the norm for OAuth/subscription-billed
 * Claude, Codex, and Antigravity runs rather than API-key-metered ones. Cache
 * creation is priced at the short-TTL write rate, the same simplification
 * {@link totalTokens} already makes, since `TokenUsage` doesn't track cache TTL.
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
