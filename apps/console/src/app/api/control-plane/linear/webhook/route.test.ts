// @vitest-environment node
import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getConfig, admit, getRuntime, afterResponse, drain } = vi.hoisted(
  () => ({
    getConfig: vi.fn(),
    admit: vi.fn(),
    getRuntime: vi.fn(),
    afterResponse: vi.fn(),
    drain: vi.fn(),
  }),
);
vi.mock('@/lib/linear-config', () => ({ linearConfig: getConfig }));
vi.mock('@/lib/orchestrator-runtime', () => ({
  createOrchestratorRuntime: getRuntime,
}));
vi.mock('@/lib/linear-intake', async (original) => ({
  ...(await original<typeof import('@/lib/linear-intake')>()),
  admitLinearWebhook: admit,
}));
vi.mock('next/server', () => ({ after: afterResponse }));

import { POST } from './route';

function request(signature?: string) {
  const body = '{"test":true}';
  return new Request(
    'https://console.example/api/control-plane/linear/webhook',
    {
      method: 'POST',
      body,
      headers: {
        'linear-signature':
          signature ??
          createHmac('sha256', 'test-secret').update(body).digest('hex'),
      },
    },
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('AGENT_LCARS_LINEAR_WEBHOOK_SECRET', 'test-secret');
  getConfig.mockReturnValue({ organizationId: 'org', routes: [] });
  getRuntime.mockReturnValue({ drain });
  admit.mockResolvedValue({
    status: 200,
    body: { outcome: 'minted', itemId: 'item-1' },
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('Linear webhook HTTP boundary', () => {
  it('requires a valid HMAC before creating a runtime or admitting work', async () => {
    const response = await POST(request('invalid'));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(getRuntime).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });
  it('acknowledges durable admission before running the dispatch drain', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ itemId: 'item-1' });
    expect(drain).not.toHaveBeenCalled();
    await afterResponse.mock.calls[0][0]();
    expect(drain).toHaveBeenCalledOnce();
  });
  it('returns retryable failure for a durable-store error', async () => {
    admit.mockRejectedValue(new Error('store unavailable'));
    expect((await POST(request())).status).toBe(500);
    expect(afterResponse).not.toHaveBeenCalled();
  });
  it('returns 503 while the optional integration is disabled', async () => {
    getConfig.mockReturnValue(undefined);
    expect((await POST(request())).status).toBe(503);
    expect(admit).not.toHaveBeenCalled();
  });
});
