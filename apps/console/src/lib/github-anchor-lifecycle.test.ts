import { describe, expect, it, vi } from 'vitest';

import {
  GITHUB_ANCHOR_LIFECYCLE_TIMEOUT_MS,
  loadGithubAnchorLifecycle,
} from './github-anchor-lifecycle';

const ANCHOR = { repo: 'octo/example', issue: 7 } as const;
const UPDATED_AT = '2026-09-12T12:42:54.000Z';

describe('loadGithubAnchorLifecycle', () => {
  it.each(['open', 'closed'] as const)(
    'returns GitHub %s state with its source timestamp',
    async (state) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(Response.json({ state, updated_at: UPDATED_AT }));
      await expect(
        loadGithubAnchorLifecycle(
          {
            tokens: { tokenFor: async () => 'token' },
            fetchImpl,
            githubApiBaseUrl: 'https://github.test',
          },
          ANCHOR,
        ),
      ).resolves.toEqual({ state, sourceUpdatedAt: UPDATED_AT });
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://github.test/repos/octo/example/issues/7',
        expect.objectContaining({ method: 'GET' }),
      );
    },
  );

  it.each([
    new Response(null, { status: 503 }),
    Response.json({ state: 'closed' }),
  ])(
    'returns unknown when GitHub cannot prove lifecycle state',
    async (response) => {
      await expect(
        loadGithubAnchorLifecycle(
          {
            tokens: { tokenFor: async () => 'token' },
            fetchImpl: vi.fn().mockResolvedValue(response),
          },
          ANCHOR,
        ),
      ).resolves.toBeUndefined();
    },
  );

  it('bounds token acquisition and the HTTP read inside one deadline', async () => {
    vi.useFakeTimers();
    try {
      const lookup = loadGithubAnchorLifecycle(
        {
          tokens: { tokenFor: () => new Promise<string>(() => undefined) },
          fetchImpl: vi.fn(),
        },
        ANCHOR,
      );
      await vi.advanceTimersByTimeAsync(GITHUB_ANCHOR_LIFECYCLE_TIMEOUT_MS);
      await expect(lookup).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
