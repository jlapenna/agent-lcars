import { describe, expect, it } from 'vitest';

import { findDeliverables } from './deliverables';

describe('findDeliverables', () => {
  it('finds commit SHAs in bracket output without regex backtracking', () => {
    expect(
      findDeliverables(
        '[main abcdef1] first\n[feature 0123456789abcdef] second',
      ),
    ).toEqual({ prNumbers: [], commitShas: ['abcdef1', '0123456789abcdef'] });
  });

  it('skips malformed bracket output and continues scanning later entries', () => {
    expect(findDeliverables('[broken nope] [main fedcba9]')).toEqual({
      prNumbers: [],
      commitShas: ['fedcba9'],
    });
  });
});
