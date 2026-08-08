import { beforeEach, describe, expect, it, vi } from 'vitest';

const { inspectWebhookIngressProbe, verifyWebhookIngressCanaryOidcToken } =
  vi.hoisted(() => ({
    inspectWebhookIngressProbe: vi.fn(),
    verifyWebhookIngressCanaryOidcToken: vi.fn(),
  }));

vi.mock('@/lib/github-actions-oidc', () => ({
  verifyWebhookIngressCanaryOidcToken,
}));
vi.mock('@/lib/webhook-ingress-probe', () => ({ inspectWebhookIngressProbe }));

import { POST } from './route';

const identity = {
  repository: 'jlapenna/agent-lcars',
  repositoryId: 1_307_149_765,
  runId: 93_099_054_125,
};
const body = {
  deliveryId: '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820',
  issue: 796,
  action: 'closed',
  sourceId: 'timeline:12345',
};

beforeEach(() => {
  vi.clearAllMocks();
  verifyWebhookIngressCanaryOidcToken.mockResolvedValue(identity);
  inspectWebhookIngressProbe.mockResolvedValue({ ...body, stage: 'success' });
});

describe('POST /api/control-plane/webhook/probe', () => {
  it('returns exact authority evidence to the signed canary workflow', async () => {
    const request = new Request('https://console.test/probe', {
      method: 'POST',
      headers: { authorization: 'Bearer oidc-token' },
      body: JSON.stringify(body),
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(inspectWebhookIngressProbe).toHaveBeenCalledWith({
      identity,
      request: body,
    });
    await expect(response.json()).resolves.toMatchObject({ stage: 'success' });
  });

  it('rejects a caller without the exact workflow OIDC identity', async () => {
    verifyWebhookIngressCanaryOidcToken.mockRejectedValue(
      new Error('wrong workflow'),
    );
    const response = await POST(
      new Request('https://console.test/probe', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-token' },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(401);
    expect(inspectWebhookIngressProbe).not.toHaveBeenCalled();
  });
});
