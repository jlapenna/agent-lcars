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

/** Like `fetchReturning`, but also records every URL requested, so a test
 *  can assert the lookup is keyed on the token's own `identity.runId`/
 *  `repo` -- not on anything the caller supplies in the completion body
 *  (which `bindCompletionToRun` never even sees). */
function fetchRecording(
  status: number,
  body: unknown,
): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe('bindCompletionToRun', () => {
  it('binds when the Actions run named by the token carries the marker for this run', async () => {
    const { fetchImpl, urls } = fetchRecording(200, {
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
    // The lookup is keyed on the verified token's own `identity.runId` and
    // the resolved `repo` -- never on the caller-supplied `runId`
    // (business run id) or anything else in the completion body.
    expect(urls).toEqual([
      `https://api.github.com/repos/octo/example/actions/runs/${identity.runId}`,
    ]);
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

  it('refuses with no-marker when the named run carries no dispatch marker at all', async () => {
    // A manually triggered `workflow_dispatch` (or any run predating the
    // broker rollout) has a `display_title` GitHub renders itself, with no
    // `[dispatch:...]` marker for `parseDispatchMarker` to find -- see
    // `run-binding.ts`'s `no-marker` branch.
    const fetchImpl = fetchReturning(200, {
      display_title: '#7: Claude implement',
    });
    await expect(
      bindCompletionToRun(
        { tokens, fetchImpl },
        identity,
        'octo/example#7/r1',
        'octo/example',
      ),
    ).resolves.toEqual({ bound: false, reason: 'no-marker' });
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

  it('fails closed when the fetch itself rejects', async () => {
    const fetchImpl = (async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;
    await expect(
      bindCompletionToRun(
        { tokens, fetchImpl },
        identity,
        'octo/example#7/r1',
        'octo/example',
      ),
    ).rejects.toBeInstanceOf(BindingUnavailable);
  });

  it('fails closed on a 2xx response with a non-JSON body', async () => {
    const fetchImpl = (async () =>
      new Response('not json', { status: 200 })) as unknown as typeof fetch;
    await expect(
      bindCompletionToRun(
        { tokens, fetchImpl },
        identity,
        'octo/example#7/r1',
        'octo/example',
      ),
    ).rejects.toBeInstanceOf(BindingUnavailable);
  });
});
