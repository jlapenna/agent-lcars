import {
  WEBHOOK_INGRESS_CANARY_MARKER,
  WEBHOOK_INGRESS_CANARY_TITLE,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  identifyWebhookIngressCanary,
  parseCloudTasksAttempt,
  recordWebhookIngressEnqueued,
  recordWebhookIngressProcessing,
  type WebhookIngressReceiptPatch,
  type WebhookIngressReceiptPort,
} from './webhook-ingress-receipt';

const deliveryId = '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820';
const payload = {
  action: 'closed',
  repository: {
    id: 1_307_149_765,
    full_name: 'jlapenna/agent-lcars',
  },
  issue: {
    id: 1,
    number: 796,
    title: WEBHOOK_INGRESS_CANARY_TITLE,
    body: WEBHOOK_INGRESS_CANARY_MARKER,
    labels: [],
    created_at: '2026-08-08T00:00:00.000Z',
    updated_at: '2026-08-08T12:00:00.000Z',
    state: 'closed',
  },
};

describe('webhook ingress canary receipts', () => {
  it('recognizes only close/reopen deliveries for the exact sentinel', () => {
    expect(identifyWebhookIngressCanary(deliveryId, 'issues', payload)).toEqual(
      {
        deliveryId,
        eventName: 'issues',
        action: 'closed',
        repository: 'jlapenna/agent-lcars',
        repositoryId: 1_307_149_765,
        issue: 796,
      },
    );
    expect(
      identifyWebhookIngressCanary(deliveryId, 'issues', {
        ...payload,
        action: 'labeled',
      }),
    ).toBeUndefined();
    expect(
      identifyWebhookIngressCanary(deliveryId, 'issues', {
        ...payload,
        issue: { ...payload.issue, title: 'Impostor sentinel' },
      }),
    ).toBeUndefined();
  });

  it('derives a one-based processor attempt from Cloud Tasks retry count', () => {
    expect(parseCloudTasksAttempt(null)).toBe(1);
    expect(parseCloudTasksAttempt('0')).toBe(1);
    expect(parseCloudTasksAttempt('3')).toBe(4);
    expect(() => parseCloudTasksAttempt('-1')).toThrow('retry count');
  });

  it('merges queue and processor checkpoints without replacing identity', async () => {
    const patches: WebhookIngressReceiptPatch[] = [];
    const port: WebhookIngressReceiptPort = {
      merge: vi.fn(async (patch) => {
        patches.push(patch);
      }),
      read: vi.fn(),
    };
    const identity = identifyWebhookIngressCanary(
      deliveryId,
      'issues',
      payload,
    );
    expect(identity).toBeDefined();

    await recordWebhookIngressEnqueued(
      identity!,
      'enqueued',
      port,
      '2026-08-08T12:00:01.000Z',
    );
    await recordWebhookIngressProcessing(
      identity!,
      2,
      port,
      '2026-08-08T12:00:02.000Z',
    );

    expect(patches).toEqual([
      {
        deliveryId,
        enqueuedAt: '2026-08-08T12:00:01.000Z',
        enqueueOutcome: 'enqueued',
      },
      {
        deliveryId,
        processorAttempt: 2,
        processorStartedAt: '2026-08-08T12:00:02.000Z',
      },
    ]);
  });
});
