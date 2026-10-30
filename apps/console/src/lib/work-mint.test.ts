import { describe, expect, it } from 'vitest';

import { sameSpec } from './work-mint';

const recipe = {
  title: 'T',
  description: 'D',
  pipeline: 'goose',
  priority: 'background',
  target: { repo: 'jlapenna/agent-lcars' },
  jobOccurrence: 'a'.repeat(64),
};

describe('sameSpec', () => {
  it('compares stored recipe Work without throwing', () => {
    expect(sameSpec(recipe, { ...recipe })).toBe(true);
    expect(sameSpec(recipe, { ...recipe, title: 'Other' })).toBe(false);
  });

  it('treats a coding spec as different from stored recipe Work', () => {
    expect(
      sameSpec(recipe, {
        title: 'T',
        description: 'D',
        pipeline: 'claude',
        target: { repo: 'jlapenna/agent-lcars' },
      }),
    ).toBe(false);
  });
});
