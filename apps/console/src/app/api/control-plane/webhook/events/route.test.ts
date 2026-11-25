// @vitest-environment node
import crypto from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { routeGithubAgentEvents } = vi.hoisted(() => ({
  routeGithubAgentEvents: vi.fn(),
}));

vi.mock('@/lib/github-agent-event-intake', () => ({ routeGithubAgentEvents }));

import { POST } from './route';

const SECRET = 'test-webhook-secret';
const DELIVERY = 'e29e8f0a-7530-11f0-9f9d-8f1bc3e88820';

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://console.test/api/control-plane/webhook/events', {
    method: 'POST',
    body,
    headers: {
      'x-github-delivery': DELIVERY,
      'x-github-event': 'pull_request_review',
      'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`,
      ...headers,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env['AGENT_LCARS_WEBHOOK_SECRET'] = SECRET;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env['AGENT_LCARS_WEBHOOK_SECRET'];
  vi.restoreAllMocks();
});

describe('POST /api/control-plane/webhook/events', () => {
  it('routes the signed delivery', async () => {
    routeGithubAgentEvents.mockResolvedValue({
      deliveryId: DELIVERY,
      events: [],
    });
    const response = await POST(request('{"action":"submitted"}'));
    expect(response.status).toBe(200);
    expect(routeGithubAgentEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'pull_request_review',
        deliveryId: DELIVERY,
        payload: { action: 'submitted' },
      }),
    );
  });

  it('rejects a bad signature', async () => {
    const response = await POST(
      request('{}', { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }),
    );
    expect(response.status).toBe(401);
    expect(routeGithubAgentEvents).not.toHaveBeenCalled();
  });

  it('acknowledges an unreadable delivery instead of retrying it', async () => {
    const response = await POST(request('not json'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'dropped_permanent',
    });
    expect(routeGithubAgentEvents).not.toHaveBeenCalled();
  });

  it('answers 500 on a routing failure so Cloud Tasks retries', async () => {
    routeGithubAgentEvents.mockRejectedValue(new Error('pubsub down'));
    const response = await POST(
      request('{}', { 'x-cloudtasks-taskretrycount': '2' }),
    );
    expect(response.status).toBe(500);
  });

  it('drops the delivery loudly at the attempt cap', async () => {
    routeGithubAgentEvents.mockRejectedValue(new Error('pubsub down'));
    const response = await POST(
      request('{}', { 'x-cloudtasks-taskretrycount': '9' }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'dropped_after_retries',
      attempt: 10,
    });
  });
});
