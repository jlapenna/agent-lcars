import { describe, expect, it } from 'vitest';

import { totalTokens } from './tokens';

describe('totalTokens', () => {
  it('weights cache creation and reads by their relative Claude cost', () => {
    expect(
      totalTokens({
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 5,
        cacheReadTokens: 10,
      }),
    ).toBe(157);
  });

  it('keeps cache reads from dominating a long, heavily cached session', () => {
    // The shape a real multi-turn Claude Code session actually produces:
    // each turn's fresh input/output is small, but every turn re-reads the
    // full prior context from cache, so cacheReadTokens dwarfs the rest.
    // A total that dropped this field would look like a rounding error
    // rather than the bulk of the session's real usage.
    expect(
      totalTokens({
        inputTokens: 500,
        outputTokens: 200,
        cacheCreationTokens: 1_000,
        cacheReadTokens: 250_000,
      }),
    ).toBe(26_950);
  });

  it('returns 0 for all-zero usage', () => {
    expect(
      totalTokens({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(0);
  });
});
