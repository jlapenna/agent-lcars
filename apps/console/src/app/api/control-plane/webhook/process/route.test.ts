// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createOrchestratorRuntime,
  enqueueGitHubWebhook,
  handleWebhookDelivery,
  ProjectionRefreshError,
} = vi.hoisted(() => {
  class ProjectionRefreshError extends Error {
    override readonly name = 'ProjectionRefreshError';
  }
  return {
    createOrchestratorRuntime: vi.fn(),
    enqueueGitHubWebhook: vi.fn(),
    handleWebhookDelivery: vi.fn(),
    ProjectionRefreshError,
  };
});

vi.mock('@/lib/orchestrator-runtime', () => ({ createOrchestratorRuntime }));
vi.mock('@/lib/hosted-webhook-queue', () => ({ enqueueGitHubWebhook }));
vi.mock('@/lib/orchestrator-routes', () => ({
  handleWebhookDelivery,
  ProjectionRefreshError,
}));
vi.mock('@/lib/github-webhook-auth', () => ({
  verifyWebhookSignature: vi.fn(() => true),
}));

import { POST } from './route';

function request(retryCount: string, repairGeneration?: string): Request {
  return new Request('https://console.test/api/control-plane/webhook/process', {
    method: 'POST',
    body: JSON.stringify({ repository: { full_name: 'jlapenna/agent-lcars' } }),
    headers: {
      'x-cloudtasks-taskretrycount': retryCount,
      ...(repairGeneration === undefined
        ? {}
        : { 'x-agent-lcars-projection-repair-generation': repairGeneration }),
      'x-github-delivery': 'projection-refresh-delivery',
      'x-github-event': 'issues',
      'x-hub-signature-256': 'sha256=ignored-by-mock',
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env['AGENT_LCARS_WEBHOOK_SECRET'] = 'test-webhook-secret';
  createOrchestratorRuntime.mockReturnValue({});
  enqueueGitHubWebhook.mockResolvedValue({ outcome: 'enqueued' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env['AGENT_LCARS_WEBHOOK_SECRET'];
  vi.restoreAllMocks();
});

describe('POST /api/control-plane/webhook/process', () => {
  it('hands a projection-only repair to a durable successor at the retry cap', async () => {
    handleWebhookDelivery.mockRejectedValue(
      new ProjectionRefreshError('GitHub exact refresh unavailable'),
    );

    const response = await POST(request('9'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      outcome: 'projection_repair_requeued',
      attempt: 10,
    });
    expect(enqueueGitHubWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: 'projection-refresh-delivery',
        repairGeneration: 1,
      }),
    );
    expect(handleWebhookDelivery).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        event: 'issues',
        deliveryId: 'projection-refresh-delivery',
      }),
    );
  });

  it('advances the predecessor repair generation after the successor exhausts its own retries', async () => {
    handleWebhookDelivery.mockRejectedValue(
      new ProjectionRefreshError('GitHub exact refresh unavailable'),
    );

    const response = await POST(request('9', '1'));

    expect(response.status).toBe(200);
    expect(enqueueGitHubWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: 'projection-refresh-delivery',
        repairGeneration: 2,
      }),
    );
  });
});
