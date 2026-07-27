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
