import { describe, expect, it } from 'vitest';

import { bindCompletionToRun, BindingUnavailable } from './run-binding';

const identity = {
  repository: 'octo/example',
  repositoryId: 42,
  runId: 987654321,
  workflow: 'claude.yml',
};
const tokens = { tokenFor: async () => 'ghs_token' };

function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('bindCompletionToRun', () => {
  it('binds when the Actions run named by the token carries the marker for this run', async () => {
    const fetchImpl = fetchReturning(200, {
      display_title: '#7: Claude implement [dispatch:g1:octo/example#7/r1]',
    });
    await expect(
      bindCompletionToRun(
        { tokens, fetchImpl },
        identity,
        'octo/example#7/r1',
        'octo/example',
      ),
    ).resolves.toEqual({ bound: true });
  });

  it('binds a native run id too', async () => {
    const fetchImpl = fetchReturning(200, {
      display_title: 'work [dispatch:g1:work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1]',
    });
    await expect(
      bindCompletionToRun(
        { tokens, fetchImpl },
        identity,
        'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
        'octo/example',
      ),
    ).resolves.toEqual({ bound: true });
  });

  it('refuses when the marker names a different run', async () => {
    const fetchImpl = fetchReturning(200, {
      display_title: '#7: [dispatch:g1:octo/example#7/r2]',
    });
    await expect(
      bindCompletionToRun(
        { tokens, fetchImpl },
        identity,
        'octo/example#7/r1',
        'octo/example',
      ),
    ).resolves.toEqual({ bound: false, reason: 'marker-mismatch' });
  });

  it('refuses when the token names a run in another repository', async () => {
    await expect(
      bindCompletionToRun(
        { tokens, fetchImpl: fetchReturning(200, {}) },
        identity,
        'octo/example#7/r1',
        'other/repo',
      ),
    ).resolves.toEqual({ bound: false, reason: 'marker-mismatch' });
  });

  it('fails closed when GitHub is unavailable', async () => {
    await expect(
      bindCompletionToRun(
        { tokens, fetchImpl: fetchReturning(502, {}) },
        identity,
        'octo/example#7/r1',
        'octo/example',
      ),
    ).rejects.toBeInstanceOf(BindingUnavailable);
  });
});
