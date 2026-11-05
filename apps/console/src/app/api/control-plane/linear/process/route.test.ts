// @vitest-environment node
import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  audience: vi.fn(),
  config: vi.fn(),
  admit: vi.fn(),
  runtime: vi.fn(),
  drain: vi.fn(),
  enqueue: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock('@/lib/work-auth', () => ({ googleIdTokenVerifier: mocks.audience }));
vi.mock('@/lib/linear-config', () => ({ linearConfig: mocks.config }));
vi.mock('@/lib/orchestrator-runtime', () => ({
  createOrchestratorRuntime: mocks.runtime,
}));
vi.mock('@/lib/linear-intake', async (original) => ({
  ...(await original<typeof import('@/lib/linear-intake')>()),
  admitLinearWebhook: mocks.admit,
}));
vi.mock('@/lib/hosted-webhook-queue', () => ({
  enqueueLinearWebhook: mocks.enqueue,
}));
vi.mock('next/cache', () => ({ revalidateTag: mocks.revalidate }));
import { POST } from './route';
const raw = JSON.stringify({
  type: 'Issue',
  action: 'update',
  webhookTimestamp: 1,
  organizationId: '11111111-1111-4111-8111-111111111111',
  data: { id: '44444444-4444-4444-8444-444444444444' },
});
function request(headers: Record<string, string> = {}) {
  return new Request(
    'https://console.example/api/control-plane/linear/process',
    {
      method: 'POST',
      body: raw,
      headers: {
        authorization: 'Bearer google-token',
        'linear-signature': createHmac('sha256', 'secret')
          .update(raw)
          .digest('hex'),
        ...headers,
      },
    },
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('AUTH_URL', 'https://console.example/');
  vi.stubEnv(
    'AGENT_LCARS_WEBHOOK_TASK_SERVICE_ACCOUNT',
    'tasks@example.iam.gserviceaccount.com',
  );
  vi.stubEnv('AGENT_LCARS_LINEAR_WEBHOOK_SECRET', 'secret');
  mocks.verify.mockResolvedValue({
    email: 'tasks@example.iam.gserviceaccount.com',
    emailVerified: true,
  });
  mocks.audience.mockReturnValue(mocks.verify);
  mocks.config.mockReturnValue({
    organizationId: '11111111-1111-4111-8111-111111111111',
  });
  mocks.runtime.mockReturnValue({ drain: mocks.drain });
  mocks.admit.mockResolvedValue({ status: 200, body: { outcome: 'minted' } });
  mocks.enqueue.mockResolvedValue({ outcome: 'enqueued' });
});
afterEach(() => vi.unstubAllEnvs());
describe('queued Linear authenticated processor', () => {
  it('exports semantic HTTP 200 drops as bounded error telemetry', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      vi.stubEnv('FORCE_STRUCTURED_LOGGING', 'true');
      mocks.admit.mockRejectedValue(new Error('private provider response'));
      const response = await POST(
        request({
          'x-cloudtasks-taskretrycount': '10',
          'x-agent-lcars-projection-repair-generation': '10',
        }),
      );
      expect(response.status).toBe(200);
      expect(
        log.mock.calls.map(([line]) => JSON.parse(line as string)),
      ).toContainEqual({
        severity: 'ERROR',
        message: 'LCARS Linear webhook outcome',
        component: 'lcars-webhook',
        tracker: 'linear',
        stage: 'process',
        outcome: 'projection_repair_dropped',
      });
    } finally {
      log.mockRestore();
    }
  });
  it('accepts delayed signed bytes only behind the exact Google audience and verified task identity', async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.audience).toHaveBeenCalledWith(
      'https://console.example/api/control-plane/linear/process',
    );
    expect(mocks.verify).toHaveBeenCalledWith('google-token');
    expect(mocks.admit).toHaveBeenCalledWith(
      Buffer.from(raw),
      expect.anything(),
      expect.anything(),
      expect.any(Number),
      expect.objectContaining({ authenticatedQueueDelivery: true }),
    );
    expect(mocks.drain).toHaveBeenCalledOnce();
  });
  it.each([
    { email: 'wrong@example.com', emailVerified: true },
    { email: 'tasks@example.iam.gserviceaccount.com', emailVerified: false },
  ])('refuses wrong or unverified identities: %j', async (identity) => {
    mocks.verify.mockResolvedValue(identity);
    expect((await POST(request())).status).toBe(401);
    expect(mocks.admit).not.toHaveBeenCalled();
  });
  it('does not accept an unauthenticated caller with a copied valid Linear HMAC', async () => {
    expect((await POST(request({ authorization: '' }))).status).toBe(401);
    expect(mocks.admit).not.toHaveBeenCalled();
  });
  it('requires the original HMAC even for authenticated queue processing', async () => {
    const response = await POST(request({ 'linear-signature': 'invalid' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: 'dropped_permanent',
    });
    expect(mocks.admit).not.toHaveBeenCalled();
  });
  it('retries transient failures then moves poison work to a bounded delayed repair', async () => {
    mocks.admit.mockRejectedValue(new Error('API rate limited'));
    expect(
      (await POST(request({ 'x-cloudtasks-taskretrycount': '1' }))).status,
    ).toBe(500);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    const response = await POST(
      request({ 'x-cloudtasks-taskretrycount': '10' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: 'projection_repair_requeued',
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      Buffer.from(raw),
      expect.any(String),
      undefined,
      { generation: 1, notBefore: expect.any(Date) },
    );
    mocks.enqueue.mockRejectedValue(new Error('queue unavailable'));
    expect(
      (await POST(request({ 'x-cloudtasks-taskretrycount': '10' }))).status,
    ).toBe(500);
  });
  it('stops bounded repair generations with a visible exhausted outcome', async () => {
    mocks.admit.mockRejectedValue(new Error('poison'));
    const response = await POST(
      request({
        'x-cloudtasks-taskretrycount': '10',
        'x-agent-lcars-projection-repair-generation': '10',
      }),
    );
    expect(await response.json()).toMatchObject({
      outcome: 'projection_repair_dropped',
      repairGeneration: 10,
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
