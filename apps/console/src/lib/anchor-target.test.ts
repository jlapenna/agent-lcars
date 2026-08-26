import { describe, expect, it } from 'vitest';

import { anchorTarget, UnresolvableAnchor } from './anchor-target';

const WORK = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' };

describe('anchorTarget', () => {
  it('reads repo and issue off a GitHub anchor', () => {
    expect(anchorTarget({ task: { repo: 'octo/example', issue: 7 } })).toEqual({
      repo: 'octo/example',
      issue: 7,
    });
  });

  it('reads the target repo off a native task payload', () => {
    expect(
      anchorTarget(
        { task: WORK },
        { work: { spec: { target: { repo: 'octo/example' } } } },
      ),
    ).toEqual({ repo: 'octo/example' });
  });

  it('throws when a native task carries no target repo', () => {
    expect(() => anchorTarget({ task: WORK }, { work: {} })).toThrow(
      UnresolvableAnchor,
    );
    expect(() => anchorTarget({ task: WORK })).toThrow(UnresolvableAnchor);
  });
});
