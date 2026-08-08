import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  enqueueGitHubWebhook,
  type GitHubWebhookEnvelope,
  type WebhookTaskQueue,
} from './hosted-webhook-queue';

const envelope: GitHubWebhookEnvelope = {
  rawBody: Buffer.from('{"action":"opened"}'),
  deliveryId: '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820',
  eventName: 'issues',
  signature: `sha256=${'a'.repeat(64)}`,
};

beforeEach(() => {
  vi.stubEnv('AUTH_URL', 'https://agent-console.example.test/');
});

describe('hosted GitHub webhook queue', () => {
  it('durably queues the original authenticated envelope by delivery ID', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const queue: WebhookTaskQueue = { enqueue };

    await expect(enqueueGitHubWebhook(envelope, queue)).resolves.toEqual({
      deliveryId: envelope.deliveryId,
      eventName: 'issues',
      outcome: 'enqueued',
    });
    expect(enqueue).toHaveBeenCalledWith({
      taskId: `github-${envelope.deliveryId}`,
      url: 'https://agent-console.example.test/api/control-plane/webhook/process',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': envelope.deliveryId,
        'x-github-event': 'issues',
        'x-hub-signature-256': envelope.signature,
      },
      body: envelope.rawBody,
    });
  });

  it('treats an existing named task as an acknowledged redelivery', async () => {
    const queue: WebhookTaskQueue = {
      enqueue: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error(), { code: 6 })),
    };

    await expect(enqueueGitHubWebhook(envelope, queue)).resolves.toMatchObject({
      outcome: 'duplicate',
    });
  });

  it('propagates failures that did not establish durable ownership', async () => {
    const error = Object.assign(new Error('unavailable'), { code: 14 });
    const queue: WebhookTaskQueue = {
      enqueue: vi.fn().mockRejectedValue(error),
    };

    await expect(enqueueGitHubWebhook(envelope, queue)).rejects.toBe(error);
  });
});
