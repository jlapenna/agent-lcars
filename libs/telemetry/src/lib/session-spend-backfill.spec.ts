import { describe, expect, it } from 'vitest';

import { spendBackfillCoverageVerdict } from './session-spend-backfill';

describe('spendBackfillCoverageVerdict', () => {
  it('certifies a clean scan that counted the whole window', () => {
    expect(
      spendBackfillCoverageVerdict({ resumed: false, stale: 0, unusable: 0 }),
    ).toBe('Indexed totals are covered for this window.');
  });

  it('withholds the verdict when a full scan still has stale or unusable docs', () => {
    expect(
      spendBackfillCoverageVerdict({ resumed: false, stale: 0, unusable: 2 }),
    ).toContain('not covered');
    expect(
      spendBackfillCoverageVerdict({ resumed: false, stale: 3, unusable: 0 }),
    ).toContain('not covered');
  });

  it('labels a clean suffix run as suffix-only instead of certifying the window', () => {
    const verdict = spendBackfillCoverageVerdict({
      resumed: true,
      stale: 0,
      unusable: 0,
    });

    expect(verdict).toContain('Suffix-only');
    expect(verdict).toContain('not a whole-window coverage verdict');
    expect(verdict).not.toContain('Indexed totals are covered');
  });

  it('reports the suffix counters when the resumed scan is not clean', () => {
    const verdict = spendBackfillCoverageVerdict({
      resumed: true,
      stale: 1,
      unusable: 2,
    });

    expect(verdict).toContain('1 stale, 2 without readable usage');
    expect(verdict).toContain('Suffix-only');
  });
});
