// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createOrchestratorRuntime,
  handleWebhookDelivery,
  ProjectionRefreshError,
} = vi.hoisted(() => {
  class ProjectionRefreshError extends Error {
    override readonly name = 'ProjectionRefreshError';
  }
  return {
    createOrchestratorRuntime: vi.fn(),
    handleWebhookDelivery: vi.fn(),
    ProjectionRefreshError,
  };
});

vi.mock('@/lib/orchestrator-runtime', () => ({ createOrchestratorRuntime }));
vi.mock('@/lib/orchestrator-routes', () => ({
  handleWebhookDelivery,
  ProjectionRefreshError,
}));
vi.mock('@/lib/github-webhook-auth', () => ({
  verifyWebhookSignature: vi.fn(() => true),
}));

import { POST } from './route';

function request(retryCount: string): Request {
  return new Request('https://console.test/api/control-plane/webhook/process', {
    method: 'POST',
    body: JSON.stringify({ repository: { full_name: 'jlapenna/agent-lcars' } }),
    headers: {
      'x-cloudtasks-taskretrycount': retryCount,
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
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env['AGENT_LCARS_WEBHOOK_SECRET'];
  vi.restoreAllMocks();
});

describe('POST /api/control-plane/webhook/process', () => {
  it('retains a projection-only repair after the generic retry cap', async () => {
    handleWebhookDelivery.mockRejectedValue(
      new ProjectionRefreshError('GitHub exact refresh unavailable'),
    );

    const response = await POST(request('9'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Projection refresh pending repair',
      attempt: 10,
    });
    expect(handleWebhookDelivery).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        event: 'issues',
        deliveryId: 'projection-refresh-delivery',
      }),
    );
  });
});
