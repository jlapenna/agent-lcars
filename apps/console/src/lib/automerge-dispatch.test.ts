import { describe, expect, it, vi } from 'vitest';

import { dispatchAutomergeReconcile } from './automerge-dispatch';

vi.mock('server-only', () => ({}));

const tokens = { tokenFor: vi.fn(async (repo: string) => `token-for-${repo}`) };

function fetchReturning(status: number) {
  return vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(status === 204 ? null : 'body', { status }),
  );
}

describe('dispatchAutomergeReconcile', () => {
  it("dispatches the repository's own auto-merge workflow on its default branch", async () => {
    const fetchImpl = fetchReturning(204);

    await expect(
      dispatchAutomergeReconcile(
        { tokens, fetchImpl: fetchImpl as typeof fetch },
        'jlapenna/homelab',
        'main',
      ),
    ).resolves.toBe('dispatched');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      'https://api.github.com/repos/jlapenna/homelab/actions/workflows/agent-automerge.yml/dispatches',
    );
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ ref: 'main' });
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer token-for-jlapenna/homelab',
    );
  });

  it('treats a repository without the workflow as nothing to arm', async () => {
    await expect(
      dispatchAutomergeReconcile(
        { tokens, fetchImpl: fetchReturning(404) as typeof fetch },
        'jlapenna/no-automerge',
        'main',
      ),
    ).resolves.toBe('no-workflow');
  });

  it('throws on any other refusal', async () => {
    await expect(
      dispatchAutomergeReconcile(
        { tokens, fetchImpl: fetchReturning(403) as typeof fetch },
        'jlapenna/homelab',
        'main',
      ),
    ).rejects.toThrow(
      'auto-merge sweep dispatch for jlapenna/homelab failed: 403',
    );
  });
});
