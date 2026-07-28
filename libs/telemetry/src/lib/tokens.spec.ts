import { describe, expect, it } from 'vitest';

import { estimateCostUsd, totalTokens } from './tokens';

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

describe('estimateCostUsd', () => {
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
  };

  it('prices a known bare model alias at its published per-million rates', () => {
    // claude-opus-5: $5 input, $25 output, $6.25 cache write, $0.50 cache read
    expect(estimateCostUsd('claude-opus-5', usage)).toBeCloseTo(36.75, 6);
  });

  it('resolves a dated snapshot id to the same rate as its bare alias', () => {
    expect(estimateCostUsd('claude-opus-4-1-20250805', usage)).toBeCloseTo(
      estimateCostUsd('claude-opus-4-1', usage) ?? NaN,
      6,
    );
  });

  it('does not cross-match a shorter sibling prefix (opus-4-1 vs opus-4-5)', () => {
    // Opus 4.1 ($15/$75) is far more expensive than Opus 4.5 ($5/$25) - a
    // wrong (too-short) prefix match would silently misprice one as the
    // other.
    const opus41 = estimateCostUsd('claude-opus-4-1-20250805', usage);
    const opus45 = estimateCostUsd('claude-opus-4-5-20251101', usage);
    expect(opus41).not.toBe(opus45);
    expect(opus41).toBeCloseTo(15 + 75 + 18.75 + 1.5, 6);
    expect(opus45).toBeCloseTo(5 + 25 + 6.25 + 0.5, 6);
  });

  it('returns undefined for an unrecognized model id', () => {
    expect(estimateCostUsd('some-other-vendor-model', usage)).toBeUndefined();
  });

  it('returns undefined when model is absent', () => {
    expect(estimateCostUsd(undefined, usage)).toBeUndefined();
  });

  it('returns 0 for a known model with all-zero usage', () => {
    expect(
      estimateCostUsd('claude-sonnet-5', {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(0);
  });
});
