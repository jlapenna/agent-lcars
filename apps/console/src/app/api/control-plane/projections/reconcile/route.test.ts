import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock('@/lib/github-actions-oidc', () => ({
  verifyAnchorProjectionBackfillOidcToken: mocks.verify,
}));
vi.mock('@/lib/github-anchor-reconcile', () => ({
  AnchorProjectionBackfillLimitError: class AnchorProjectionBackfillLimitError extends Error {},
  reconcileCurrentGithubAnchorProjections: mocks.reconcile,
}));

import { POST } from './route';

describe('POST /api/control-plane/projections/reconcile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires the dedicated OIDC caller before backfill ingestion', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('bad token'));

    const response = await POST(
      new Request(
        'https://console.test/api/control-plane/projections/reconcile',
        {
          method: 'POST',
          headers: { authorization: 'Bearer token' },
        },
      ),
    );

    expect(response.status).toBe(401);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('runs the explicit backfill after OIDC verification', async () => {
    mocks.verify.mockResolvedValueOnce({ repository: 'jlapenna/agent-lcars' });
    mocks.reconcile.mockResolvedValueOnce({ repositories: 1, anchors: 42 });

    const response = await POST(
      new Request(
        'https://console.test/api/control-plane/projections/reconcile',
        {
          method: 'POST',
          headers: { authorization: 'Bearer token' },
        },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repositories: 1,
      anchors: 42,
    });
  });

  it('accepts only the bodyless one-shot control contract', async () => {
    mocks.verify.mockResolvedValueOnce({ repository: 'jlapenna/agent-lcars' });

    const response = await POST(
      new Request(
        'https://console.test/api/control-plane/projections/reconcile',
        {
          method: 'POST',
          headers: { authorization: 'Bearer token' },
          body: '{}',
        },
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('fails closed when the selected projection does not match the current queue', async () => {
    mocks.verify.mockResolvedValueOnce({ repository: 'jlapenna/agent-lcars' });
    mocks.reconcile.mockResolvedValueOnce({
      repositories: 1,
      anchors: 42,
      comparison: {
        currentQueue: 3,
        projectedQueue: 2,
        missingProjectionKeys: ['jlapenna/agent-lcars#42'],
        unexpectedProjectionKeys: [],
        criticalFieldMismatches: [],
        warnings: [],
        matches: false,
      },
    });

    const response = await POST(
      new Request(
        'https://console.test/api/control-plane/projections/reconcile',
        {
          method: 'POST',
          headers: { authorization: 'Bearer token' },
        },
      ),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Queue projection mismatch',
      result: { comparison: { matches: false } },
    });
  });
});
