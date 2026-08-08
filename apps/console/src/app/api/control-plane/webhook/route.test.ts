import crypto from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  enqueueGitHubWebhook,
  identifyWebhookIngressCanary,
  recordWebhookIngressEnqueued,
  recordWebhookIngressReceived,
} = vi.hoisted(() => ({
  enqueueGitHubWebhook: vi.fn(),
  identifyWebhookIngressCanary: vi.fn(),
  recordWebhookIngressEnqueued: vi.fn(),
  recordWebhookIngressReceived: vi.fn(),
}));

vi.mock('@/lib/hosted-webhook-queue', () => ({
  enqueueGitHubWebhook,
}));
vi.mock('@/lib/webhook-ingress-receipt', () => ({
  identifyWebhookIngressCanary,
  recordWebhookIngressEnqueued,
  recordWebhookIngressReceived,
}));

import { POST } from './route';

const SECRET = 'route-test-webhook-secret';
const BODY = JSON.stringify({
  action: 'opened',
  repository: { id: 1_307_149_765, full_name: 'jlapenna/agent-lcars' },
  issue: { number: 736 },
});

function signature(body: string): string {
  return `sha256=${crypto
    .createHmac('sha256', SECRET)
    .update(body)
    .digest('hex')}`;
}

function request({
  body = BODY,
  signed = true,
}: { body?: string; signed?: boolean } = {}): Request {
  return new Request('https://console.test/api/control-plane/webhook', {
    method: 'POST',
    headers: {
      'x-github-delivery': '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820',
      'x-github-event': 'issues',
      'x-hub-signature-256': signed ? signature(body) : 'sha256=bad',
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AGENT_LCARS_WEBHOOK_SECRET', SECRET);
  identifyWebhookIngressCanary.mockReturnValue(undefined);
  recordWebhookIngressReceived.mockResolvedValue(undefined);
  recordWebhookIngressEnqueued.mockResolvedValue(undefined);
  enqueueGitHubWebhook.mockResolvedValue({
    deliveryId: '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820',
    eventName: 'issues',
    outcome: 'enqueued',
  });
});

describe('POST /api/control-plane/webhook', () => {
  it('rejects a payload whose raw bytes do not match the signature', async () => {
    const response = await POST(request({ signed: false }));
    expect(response.status).toBe(401);
    expect(enqueueGitHubWebhook).not.toHaveBeenCalled();
  });

  it('acknowledges only after durably queuing the authenticated raw payload', async () => {
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(enqueueGitHubWebhook).toHaveBeenCalledWith({
      rawBody: Buffer.from(BODY),
      deliveryId: '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820',
      eventName: 'issues',
      signature: signature(BODY),
    });
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'enqueued',
    });
  });

  it('acknowledges malformed signed JSON without creating a retrying task', async () => {
    const response = await POST(request({ body: '{' }));
    expect(response.status).toBe(202);
    expect(enqueueGitHubWebhook).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'ignored',
      reason: 'malformed JSON',
    });
  });

  it('acknowledges a fleet App delivery outside this control plane without queueing it', async () => {
    const body = JSON.stringify({
      action: 'opened',
      repository: { id: 123, full_name: 'supersprinklesracing/sprinkles' },
      issue: { number: 1 },
    });
    const response = await POST(request({ body }));
    expect(response.status).toBe(202);
    expect(enqueueGitHubWebhook).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'ignored',
      reason: 'repository outside control plane',
    });
  });

  it('acknowledges App ping deliveries without queueing them', async () => {
    const body = JSON.stringify({ zen: 'Keep it logically awesome.' });
    const pingRequest = new Request(
      'https://console.test/api/control-plane/webhook',
      {
        method: 'POST',
        headers: {
          'x-github-delivery': '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820',
          'x-github-event': 'ping',
          'x-hub-signature-256': signature(body),
        },
        body,
      },
    );
    const response = await POST(pingRequest);
    expect(response.status).toBe(202);
    expect(enqueueGitHubWebhook).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'ignored',
      reason: 'ping',
    });
  });

  it('does not acknowledge an enqueue failure', async () => {
    enqueueGitHubWebhook.mockRejectedValue(new Error('unavailable'));
    const response = await POST(request());
    expect(response.status).toBe(500);
  });

  it('checkpoints the signed sentinel before and after durable enqueue', async () => {
    const identity = {
      deliveryId: '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820',
      eventName: 'issues',
      action: 'closed',
      repository: 'jlapenna/agent-lcars',
      repositoryId: 1_307_149_765,
      issue: 796,
    };
    identifyWebhookIngressCanary.mockReturnValue(identity);

    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(recordWebhookIngressReceived).toHaveBeenCalledWith(identity);
    expect(recordWebhookIngressEnqueued).toHaveBeenCalledWith(
      identity,
      'enqueued',
    );
    expect(
      recordWebhookIngressReceived.mock.invocationCallOrder[0],
    ).toBeLessThan(enqueueGitHubWebhook.mock.invocationCallOrder[0]);
    expect(enqueueGitHubWebhook.mock.invocationCallOrder[0]).toBeLessThan(
      recordWebhookIngressEnqueued.mock.invocationCallOrder[0],
    );
  });
});
