import crypto from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueueGitHubWebhook } = vi.hoisted(() => ({
  enqueueGitHubWebhook: vi.fn(),
}));

vi.mock('@/lib/hosted-webhook-queue', () => ({
  enqueueGitHubWebhook,
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

  it('queues authenticated bytes without doing broker work in the request', async () => {
    const response = await POST(request({ body: '{' }));
    expect(response.status).toBe(202);
    expect(enqueueGitHubWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ rawBody: Buffer.from('{') }),
    );
  });

  it('does not acknowledge an enqueue failure', async () => {
    enqueueGitHubWebhook.mockRejectedValue(new Error('unavailable'));
    const response = await POST(request());
    expect(response.status).toBe(500);
  });
});
