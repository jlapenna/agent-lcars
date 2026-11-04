// @vitest-environment node
import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { getConfig, enqueue } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('@/lib/linear-config', () => ({ linearConfig: getConfig }));
vi.mock('@/lib/hosted-webhook-queue', () => ({
  enqueueLinearWebhook: enqueue,
}));
import { POST } from './route';
const org = '11111111-1111-4111-8111-111111111111';
const id = '44444444-4444-4444-8444-444444444444';
function request(signature?: string, overrides: Record<string, unknown> = {}) {
  const body = JSON.stringify({
    type: 'Issue',
    action: 'update',
    organizationId: org,
    webhookTimestamp: Date.now(),
    data: { id },
    ...overrides,
  });
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
  getConfig.mockReturnValue({ organizationId: org, routes: [] });
  enqueue.mockResolvedValue({ outcome: 'enqueued' });
});
afterEach(() => vi.unstubAllEnvs());
describe('Linear webhook HTTP boundary', () => {
  it('requires valid HMAC before any queue write', async () => {
    const response = await POST(request('invalid'));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('acknowledges only after Cloud Tasks durably owns the signed original bytes', async () => {
    let resolve!: (value: unknown) => void;
    enqueue.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    let acknowledged = false;
    const req = request();
    const raw = await req.clone().text();
    const response = POST(req).then((value) => {
      acknowledged = true;
      return value;
    });
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    expect(acknowledged).toBe(false);
    expect(enqueue).toHaveBeenCalledWith(
      Buffer.from(raw),
      req.headers.get('linear-signature'),
    );
    resolve({ outcome: 'enqueued' });
    expect((await response).status).toBe(200);
  });
  it('returns retryable failure if queue ownership fails', async () => {
    enqueue.mockRejectedValue(new Error('queue unavailable'));
    expect((await POST(request())).status).toBe(500);
  });
  it('rejects stale events and wrong organizations before the durable queue', async () => {
    expect(
      (await POST(request(undefined, { webhookTimestamp: Date.now() - 60001 })))
        .status,
    ).toBe(401);
    expect(
      (await POST(request(undefined, { organizationId: id }))).status,
    ).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('returns 503 while the integration is disabled', async () => {
    getConfig.mockReturnValue(undefined);
    expect((await POST(request())).status).toBe(503);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
