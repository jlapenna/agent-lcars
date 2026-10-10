import { describe, expect, it } from 'vitest';

import { findDeliverables, findQualifiedPRs } from './deliverables';

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

describe('qualified GitHub publication URLs', () => {
  it('rejects non-GitHub hosts, relative numbers and malformed or unsafe identities', () => {
    expect(
      findQualifiedPRs(
        'https://github.com.evil.test/a/b/pull/42 /pull/42 https://github.com/a/b/pull/9007199254740999 https://github.com/a/b/pull/0',
      ),
    ).toEqual([]);
    expect(
      findQualifiedPRs(
        'https://github.com/a/b/pull/42#review https://github.com/A/B/pull/42',
      ),
    ).toEqual([{ repo: { owner: 'a', name: 'b' }, number: 42 }]);
  });
});
