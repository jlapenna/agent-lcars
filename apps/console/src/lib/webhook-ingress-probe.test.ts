import { createLedger } from '@agent-lcars/dispatch-controller/broker';
import { describe, expect, it, vi } from 'vitest';

import { deliveryTransportId } from '@/lib/hosted-admission';

import { inspectWebhookIngressProbe } from './webhook-ingress-probe';
import type { WebhookIngressReceipt } from './webhook-ingress-receipt';

const identity = {
  repository: 'jlapenna/agent-lcars',
  repositoryId: 1_307_149_765,
  runId: 93_099_054_125,
};
const request = {
  deliveryId: '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820',
  issue: 796,
  action: 'closed' as const,
  sourceId: 'timeline:12345',
};
const receipt: WebhookIngressReceipt = {
  ...request,
  eventName: 'issues',
  repository: identity.repository,
  repositoryId: identity.repositoryId,
  receivedAt: '2026-08-08T12:00:00.000Z',
  enqueuedAt: '2026-08-08T12:00:01.000Z',
  processorAttempt: 1,
  processorStartedAt: '2026-08-08T12:00:02.000Z',
  processedAt: '2026-08-08T12:00:03.000Z',
};

function storedTask(transportRunId = deliveryTransportId(request.deliveryId)) {
  const ledger = createLedger({
    repository: identity.repository,
    repositoryId: identity.repositoryId,
    issue: request.issue,
  });
  ledger.sources.push({
    sourceKind: request.action,
    sourceId: request.sourceId,
    occurredAt: '2026-08-08T12:00:00.000Z',
    transportRunId,
    authorization: { observed: true, actor: 'github-actions[bot]' },
  });
  ledger.control = {
    closed: true,
    sourceId: request.sourceId,
    occurredAt: '2026-08-08T12:00:00.000Z',
  };
  return {
    task: ledger.task,
    revision: 7,
    updatedAt: '2026-08-08T12:00:03.000Z',
    signals: [],
    intents: [],
    controllerState: ledger,
  };
}

describe('webhook ingress authority probe', () => {
  it('requires the exact delivery-derived transport, timeline source, and control state', async () => {
    await expect(
      inspectWebhookIngressProbe({
        identity,
        request,
        readReceipt: vi.fn(async () => receipt),
        storagePort: { readTask: vi.fn(async () => storedTask()) },
      }),
    ).resolves.toMatchObject({
      stage: 'success',
      deliveryId: request.deliveryId,
      sourceId: request.sourceId,
      controllerRevision: 7,
    });

    await expect(
      inspectWebhookIngressProbe({
        identity,
        request,
        readReceipt: vi.fn(async () => receipt),
        storagePort: { readTask: vi.fn(async () => storedTask(99)) },
      }),
    ).resolves.toMatchObject({ stage: 'missing-durable-observation' });
  });

  it('reports repeated processor failure before any authority write', async () => {
    await expect(
      inspectWebhookIngressProbe({
        identity,
        request,
        readReceipt: vi.fn(async () => ({
          ...receipt,
          processedAt: undefined,
          lastProcessorFailure: {
            attempt: 3,
            occurredAt: '2026-08-08T12:00:05.000Z',
            message: 'controller unavailable',
          },
        })),
        storagePort: { readTask: vi.fn(async () => undefined) },
      }),
    ).resolves.toMatchObject({
      stage: 'repeated-processor-failure',
      processorAttempt: 1,
    });
  });

  it('waits for a signed delivery receipt instead of trusting caller input', async () => {
    const readTask = vi.fn();
    await expect(
      inspectWebhookIngressProbe({
        identity,
        request,
        readReceipt: vi.fn(async () => undefined),
        storagePort: { readTask },
      }),
    ).resolves.toMatchObject({ stage: 'awaiting-receipt' });
    expect(readTask).not.toHaveBeenCalled();
  });
});
