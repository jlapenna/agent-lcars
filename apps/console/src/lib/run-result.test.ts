import { describe, expect, it } from 'vitest';

import { toRunResult } from './run-result';

describe('toRunResult', () => {
  it('carries the agent final message onto the result', () => {
    expect(
      toRunResult('octo/example', 'park', undefined, 'Which database?'),
    ).toEqual({ ok: true, summary: 'park', message: 'Which database?' });
  });

  it('omits message when the runner sent none', () => {
    expect(toRunResult('octo/example', 'park', undefined, undefined)).toEqual({
      ok: true,
      summary: 'park',
    });
  });

  it('ignores a non-string message', () => {
    expect(toRunResult('octo/example', 'park', undefined, 42)).toEqual({
      ok: true,
      summary: 'park',
    });
  });
});

const commentRef = {
  kind: 'comment',
  number: 42,
  id: 99,
  url: 'https://github.com/octo/example/issues/42#issuecomment-99',
};
const reviewRef = {
  kind: 'review',
  number: 42,
  id: 100,
  url: 'https://github.com/octo/example/pull/42#pullrequestreview-100',
};

describe('verified exact artifact references', () => {
  it.each([
    [
      'pull-request',
      { kind: 'pull-request', number: 12 },
      'https://github.com/octo/example/pull/12',
    ],
    ['comment', commentRef, commentRef.url],
    ['review', reviewRef, reviewRef.url],
    ['park', commentRef, commentRef.url],
    ['no-op', commentRef, commentRef.url],
  ])('preserves the %s artifact', (outcome, reference, url) => {
    expect(
      toRunResult('octo/example', outcome, reference, undefined, {
        issue: 42,
        mode: outcome === 'review' ? 'review' : 'reply',
      }),
    ).toEqual({
      ok: true,
      summary: outcome,
      ref: url,
    });
  });
  it('retains a partial PR and its exact blocker comment', () => {
    expect(
      toRunResult(
        'octo/example',
        'park',
        {
          kind: 'pull-request',
          number: 12,
          related: [commentRef],
        },
        undefined,
        { issue: 42, mode: 'implement' },
      ),
    ).toEqual({
      ok: true,
      summary: 'park',
      ref: 'https://github.com/octo/example/pull/12',
      relatedRefs: [commentRef.url],
    });
  });
  it.each([
    { ...commentRef, url: 'javascript:alert(1)' },
    { ...commentRef, url: 'https://evil.test/issues/42#issuecomment-99' },
    {
      ...commentRef,
      url: 'https://github.com/other/repo/issues/42#issuecomment-99',
    },
    { ...commentRef, url: 'https://github.com/octo/example/issues/42' },
    {
      ...commentRef,
      url: 'https://github.com/octo/example/issues/43#issuecomment-99',
    },
    {
      ...commentRef,
      url: 'https://github.com/octo/example/issues/42#issuecomment-100',
    },
    {
      ...reviewRef,
      url: 'https://github.com/octo/example/pull/42#issuecomment-100',
    },
    { kind: 'pull-request', number: -1 },
    { kind: 'pull-request', number: 1.5 },
    { kind: 'comment', url: commentRef.url },
  ])('does not promote a malformed or unrelated reference %j', (reference) => {
    expect(
      toRunResult('octo/example', 'comment', reference, undefined, {
        issue: 42,
        mode: 'reply',
      }).ref,
    ).toBeUndefined();
  });
  it('never promotes URLs from final text or a failed verification', () => {
    expect(
      toRunResult('octo/example', 'comment', undefined, commentRef.url).ref,
    ).toBeUndefined();
    expect(
      toRunResult('octo/example', 'verification-failed', commentRef),
    ).toEqual({ ok: false, summary: 'verification-failed' });
  });
  it('allows the REST pull-request comment permalink, preserving its exact path', () => {
    const url = 'https://github.com/octo/example/pull/42#issuecomment-99';
    expect(
      toRunResult(
        'octo/example',
        'comment',
        { ...commentRef, url },
        undefined,
        { issue: 42, mode: 'reply' },
      ).ref,
    ).toBe(url);
  });
  it('does not invent links for historical or native file results', () => {
    for (const outcome of [
      'comment',
      'review',
      'park',
      'no-op',
      'unknown-success',
    ]) {
      expect(toRunResult('octo/example', outcome, null)).toEqual({
        ok: true,
        summary: outcome,
      });
    }
  });
});

it('keeps the PR but omits an unrelated blocker reference', () => {
  expect(
    toRunResult(
      'octo/example',
      'park',
      {
        kind: 'pull-request',
        number: 12,
        related: [
          {
            ...commentRef,
            number: 43,
            url: 'https://github.com/octo/example/issues/43#issuecomment-99',
          },
        ],
      },
      undefined,
      { issue: 42, mode: 'implement' },
    ),
  ).toEqual({
    ok: true,
    summary: 'park',
    ref: 'https://github.com/octo/example/pull/12',
  });
});
it('omits GitHub comment metadata for native work without a GitHub anchor', () => {
  expect(
    toRunResult('octo/example', 'park', commentRef, undefined, {
      mode: 'reply',
    }),
  ).toEqual({ ok: true, summary: 'park' });
});
