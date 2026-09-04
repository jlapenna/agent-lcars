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
