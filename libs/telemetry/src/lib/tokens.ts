import { TokenUsage } from './types';

/**
 * The token volume a session actually processed: `inputTokens` alone is
 * "non-cached input only" (see {@link TokenUsage.inputTokens}'s doc
 * comment), so a "total" that adds only `inputTokens` and `outputTokens`
 * silently drops `cacheCreationTokens`/`cacheReadTokens` — often the
 * majority of a long Claude Code session's usage, since every turn replays
 * prior context via cache reads. Every consumer that shows a session's
 * "total tokens" must call this instead of summing fields itself, so the
 * displayed total always matches the four numbers it was built from.
 */
export function totalTokens(tokens: TokenUsage): number {
  return (
    tokens.inputTokens +
    tokens.outputTokens +
    tokens.cacheCreationTokens +
    tokens.cacheReadTokens
  );
}
