import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyReconcileOidcToken, runHostedReconcile } = vi.hoisted(() => ({
  verifyReconcileOidcToken: vi.fn(),
  runHostedReconcile: vi.fn(),
}));

vi.mock('@/lib/github-actions-oidc', () => ({ verifyReconcileOidcToken }));
vi.mock('@/lib/hosted-reconciler', () => ({ runHostedReconcile }));

import { POST } from './route';

function request(token?: string): Request {
  return new Request('https://console.test/api/control-plane/reconcile', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyReconcileOidcToken.mockResolvedValue({
    repository: 'jlapenna/agent-lcars',
    repositoryId: 1_307_149_765,
    runId: 93_099_054_125,
  });
  runHostedReconcile.mockResolvedValue({
    candidates: 2,
    dispatched: 2,
    failed: [],
    openCandidates: 1,
    closedCandidates: 1,
  });
});

describe('POST /api/control-plane/reconcile', () => {
  it('rejects a request without a GitHub Actions OIDC bearer token', async () => {
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(runHostedReconcile).not.toHaveBeenCalled();
  });

  it('runs the hosted scan for an authorized reconciler workflow', async () => {
    const response = await POST(request('signed-token'));
    expect(response.status).toBe(200);
    expect(verifyReconcileOidcToken).toHaveBeenCalledWith(
      'signed-token',
      'jlapenna/agent-lcars',
    );
    expect(runHostedReconcile).toHaveBeenCalledWith({
      repository: 'jlapenna/agent-lcars',
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
    });
    await expect(response.json()).resolves.toMatchObject({
      candidates: 2,
      dispatched: 2,
    });
  });

  it('fails the scheduler request when any candidate dispatch fails', async () => {
    runHostedReconcile.mockResolvedValue({
      candidates: 2,
      dispatched: 1,
      failed: [{ issue: 20, message: 'rate limited' }],
      openCandidates: 2,
      closedCandidates: 0,
    });
    const response = await POST(request('signed-token'));
    expect(response.status).toBe(502);
  });

  it('does not run the scan when OIDC claim validation fails', async () => {
    verifyReconcileOidcToken.mockRejectedValue(new Error('wrong workflow'));
    const response = await POST(request('wrong-token'));
    expect(response.status).toBe(401);
    expect(runHostedReconcile).not.toHaveBeenCalled();
  });
});
