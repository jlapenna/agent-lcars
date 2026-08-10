import crypto from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  admitGitHubWebhook,
  identifyWebhookIngressCanary,
  parseCloudTasksAttempt,
  recordWebhookIngressProcessed,
  recordWebhookIngressProcessing,
  recordWebhookIngressProcessorFailure,
} = vi.hoisted(() => ({
  admitGitHubWebhook: vi.fn(),
  identifyWebhookIngressCanary: vi.fn(),
  parseCloudTasksAttempt: vi.fn(),
  recordWebhookIngressProcessed: vi.fn(),
  recordWebhookIngressProcessing: vi.fn(),
  recordWebhookIngressProcessorFailure: vi.fn(),
}));

vi.mock('@/lib/hosted-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hosted-admission')>()),
  admitGitHubWebhook,
}));
vi.mock('@/lib/webhook-ingress-receipt', () => ({
  identifyWebhookIngressCanary,
  parseCloudTasksAttempt,
  recordWebhookIngressProcessed,
  recordWebhookIngressProcessing,
  recordWebhookIngressProcessorFailure,
}));

import { POST } from './route';

const SECRET = 'processor-test-webhook-secret';
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
  return new Request('https://console.test/api/control-plane/webhook/process', {
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
  parseCloudTasksAttempt.mockReturnValue(1);
  recordWebhookIngressProcessed.mockResolvedValue(undefined);
  recordWebhookIngressProcessing.mockResolvedValue(undefined);
  recordWebhookIngressProcessorFailure.mockResolvedValue(undefined);
  admitGitHubWebhook.mockResolvedValue({
    deliveryId: '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820',
    eventName: 'issues',
    mode: 'authority',
    outcome: 'processed',
  });
});

describe('POST /api/control-plane/webhook/process', () => {
  it('rejects a queued payload whose raw bytes do not match the signature', async () => {
    const response = await POST(request({ signed: false }));
    expect(response.status).toBe(401);
    expect(admitGitHubWebhook).not.toHaveBeenCalled();
  });

  it('runs admission from the authenticated queued payload', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(admitGitHubWebhook).toHaveBeenCalledWith({
      deliveryId: '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820',
      eventName: 'issues',
      payload: JSON.parse(BODY),
    });
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'processed',
      mode: 'authority',
    });
  });

  it('returns a retryable failure for malformed authenticated JSON', async () => {
    const response = await POST(request({ body: '{' }));
    expect(response.status).toBe(500);
    expect(admitGitHubWebhook).not.toHaveBeenCalled();
  });

  it('records repeated sentinel processor attempts and terminal success', async () => {
    const identity = {
      deliveryId: '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820',
      eventName: 'issues',
      action: 'closed',
      repository: 'jlapenna/agent-lcars',
      repositoryId: 1_307_149_765,
      issue: 796,
    };
    identifyWebhookIngressCanary.mockReturnValue(identity);
    parseCloudTasksAttempt.mockReturnValue(3);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(recordWebhookIngressProcessing).toHaveBeenCalledWith(identity, 3);
    expect(recordWebhookIngressProcessed).toHaveBeenCalledWith(identity);
  });

  it('records a processor failure before returning a retryable response', async () => {
    const identity = {
      deliveryId: '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820',
      eventName: 'issues',
      action: 'closed',
      repository: 'jlapenna/agent-lcars',
      repositoryId: 1_307_149_765,
      issue: 796,
    };
    const failure = new Error('controller unavailable');
    identifyWebhookIngressCanary.mockReturnValue(identity);
    parseCloudTasksAttempt.mockReturnValue(2);
    admitGitHubWebhook.mockRejectedValue(failure);

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(recordWebhookIngressProcessorFailure).toHaveBeenCalledWith(
      identity,
      2,
      failure,
    );
  });
});
