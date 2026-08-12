import crypto from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { admitGitHubWebhook, PermanentAdmissionError } = vi.hoisted(() => ({
  admitGitHubWebhook: vi.fn(),
  PermanentAdmissionError: class PermanentAdmissionError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
      super(message, options);
      this.name = 'PermanentAdmissionError';
    }
  },
}));

vi.mock('@/lib/hosted-admission', () => ({
  admitGitHubWebhook,
  PermanentAdmissionError,
}));

import { POST } from './route';

const SECRET = 'webhook-process-test-secret';
const DELIVERY_ID = '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820';
const PAYLOAD = { action: 'labeled' };

function request({
  body = JSON.stringify(PAYLOAD),
  deliveryId = DELIVERY_ID,
  eventName = 'issues',
  signed = true,
  retryCount,
}: {
  body?: string;
  deliveryId?: string | null;
  eventName?: string | null;
  signed?: boolean;
  retryCount?: string;
} = {}): Request {
  const signature = `sha256=${crypto
    .createHmac('sha256', SECRET)
    .update(body)
    .digest('hex')}`;
  const headers: Record<string, string> = {
    'x-hub-signature-256': signed ? signature : 'sha256=bad',
  };
  if (deliveryId !== null) headers['x-github-delivery'] = deliveryId;
  if (eventName !== null) headers['x-github-event'] = eventName;
  if (retryCount !== undefined)
    headers['x-cloudtasks-taskretrycount'] = retryCount;
  return new Request('https://console.test/api/control-plane/webhook/process', {
    method: 'POST',
    headers,
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AGENT_LCARS_WEBHOOK_SECRET', SECRET);
  admitGitHubWebhook.mockResolvedValue({
    deliveryId: DELIVERY_ID,
    eventName: 'issues',
    mode: 'authority',
    outcome: 'processed',
  });
});

describe('POST /api/control-plane/webhook/process', () => {
  it('rejects a payload whose raw bytes do not match the signature', async () => {
    const response = await POST(request({ signed: false }));
    expect(response.status).toBe(401);
    expect(admitGitHubWebhook).not.toHaveBeenCalled();
  });

  it('admits a signed delivery', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(admitGitHubWebhook).toHaveBeenCalledWith({
      deliveryId: DELIVERY_ID,
      eventName: 'issues',
      payload: PAYLOAD,
    });
  });

  it('acks (2xx) and logs loudly instead of retrying a PermanentAdmissionError', async () => {
    admitGitHubWebhook.mockRejectedValue(
      new PermanentAdmissionError('Ambiguous issues:labeled timeline event'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockReturnValue(undefined);

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'dropped_permanent',
      deliveryId: DELIVERY_ID,
      eventName: 'issues',
    });
    const structuredLog = errorSpy.mock.calls
      .map((call) => call[0])
      .find(
        (arg): arg is string =>
          typeof arg === 'string' && arg.includes('"severity":"ERROR"'),
      );
    expect(structuredLog).toBeDefined();
    const parsed = JSON.parse(structuredLog as string) as Record<
      string,
      unknown
    >;
    expect(parsed).toMatchObject({
      severity: 'ERROR',
      deliveryId: DELIVERY_ID,
      eventName: 'issues',
      reason: 'Ambiguous issues:labeled timeline event',
    });
  });

  it('acks a malformed JSON payload as permanent rather than retrying forever', async () => {
    const response = await POST(request({ body: '{not json' }));
    expect(response.status).toBe(200);
    expect(admitGitHubWebhook).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'dropped_permanent',
    });
  });

  it('acks a delivery missing a required GitHub header as permanent', async () => {
    const response = await POST(request({ deliveryId: null }));
    expect(response.status).toBe(200);
    expect(admitGitHubWebhook).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'dropped_permanent',
    });
  });

  it('asks Cloud Tasks to retry a transient admission failure', async () => {
    admitGitHubWebhook.mockRejectedValue(new Error('Firestore unavailable'));
    const response = await POST(request());
    expect(response.status).toBe(500);
  });

  it('gives up on a transient-looking failure once it has retried past the attempt cap', async () => {
    admitGitHubWebhook.mockRejectedValue(new Error('still failing'));
    const response = await POST(request({ retryCount: '9' }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'dropped_after_retries',
      attempt: 10,
    });
  });
});
