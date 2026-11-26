import { createHmac } from 'node:crypto';

import { logger } from '@agent-lcars/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queueOutlineEvent } from '@/lib/outline-event-source';

import { OUTLINE_WEBHOOK_MAX_BYTES, POST } from './route';

vi.mock('@agent-lcars/logging', () => ({ logger: { structured: vi.fn() } }));
vi.mock('@/lib/outline-event-source', async (original) => ({
  ...(await original<typeof import('@/lib/outline-event-source')>()),
  queueOutlineEvent: vi.fn(),
}));
const secret = 'test-outline-secret';
const original = process.env.AGENT_LCARS_OUTLINE_WEBHOOK_SECRET;
const event = {
  id: '00000000-0000-4000-8000-000000000001',
  actorId: '00000000-0000-4000-8000-000000000002',
  createdAt: new Date().toISOString(),
  event: 'comments.create',
  payload: {
    model: {
      id: '00000000-0000-4000-8000-000000000003',
      documentId: '00000000-0000-4000-8000-000000000004',
      text: 'INJECT-UNTRUSTED-CONTENT',
    },
  },
};
function request(
  body = JSON.stringify(event),
  extra: Record<string, string> = {},
) {
  const at = Date.now(),
    sig = createHmac('sha256', secret)
      .update(`${at}.`)
      .update(body)
      .digest('hex');
  return new Request('https://lcars.test/api/control-plane/outline/webhook', {
    method: 'POST',
    headers: { 'outline-signature': `t=${at},s=${sig}`, ...extra },
    body,
  });
}
beforeEach(() => {
  vi.stubEnv('AGENT_LCARS_OUTLINE_SOURCE_ENABLED', 'false');
  vi.stubEnv('AGENT_LCARS_OUTLINE_DELIVERY_ENABLED', 'false');
  process.env.AGENT_LCARS_OUTLINE_WEBHOOK_SECRET = secret;
  vi.clearAllMocks();
  vi.mocked(queueOutlineEvent).mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (original === undefined)
    delete process.env.AGENT_LCARS_OUTLINE_WEBHOOK_SECRET;
  else process.env.AGENT_LCARS_OUTLINE_WEBHOOK_SECRET = original;
});
describe('Outline signed shadow receiver', () => {
  it('queues only identifiers for shadow API authorization on pike', async () => {
    vi.stubEnv('AGENT_LCARS_OUTLINE_SOURCE_ENABLED', 'true');
    expect(await (await POST(request())).json()).toEqual({
      ok: true,
      mode: 'shadow',
      outcome: 'queued',
    });
    expect(queueOutlineEvent).toHaveBeenCalledWith({
      deliveryId: event.id,
      actorId: event.actorId,
      event: event.event,
      documentId: event.payload.model.documentId,
      objectId: event.payload.model.id,
      occurredAt: event.createdAt,
    });
    expect(
      JSON.stringify(vi.mocked(queueOutlineEvent).mock.calls),
    ).not.toContain('INJECT');
  });
  it('does not acknowledge a failed enqueue and uses the deployed enqueue alert contract', async () => {
    vi.stubEnv('AGENT_LCARS_OUTLINE_SOURCE_ENABLED', 'true');
    vi.mocked(queueOutlineEvent).mockRejectedValueOnce(
      new Error('secret or provider body must not be logged'),
    );
    expect((await POST(request())).status).toBe(503);
    expect(logger.structured).toHaveBeenCalledWith(
      'error',
      expect.any(String),
      expect.objectContaining({
        component: 'lcars-agent-events',
        stage: 'enqueue',
        outcome: 'failed',
        source: 'outline',
      }),
      { enrich: false },
    );
    expect(
      JSON.stringify(vi.mocked(logger.structured).mock.calls),
    ).not.toContain('secret or provider');
  });
  it('requires both activation flags before reporting live mode', async () => {
    vi.stubEnv('AGENT_LCARS_OUTLINE_DELIVERY_ENABLED', 'true');
    expect((await (await POST(request())).json()).mode).toBe('shadow');
    vi.stubEnv('AGENT_LCARS_OUTLINE_SOURCE_ENABLED', 'true');
    expect((await (await POST(request())).json()).mode).toBe('live');
  });
  it('records only normalized identifiers and advertises shadow mode', async () => {
    const r = await POST(request());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ok: true,
      mode: 'shadow',
      outcome: 'recorded',
    });
    expect(logger.structured).toHaveBeenCalledWith(
      'info',
      'Outline agent event received',
      expect.objectContaining({
        mode: 'shadow',
        outcome: 'shadow',
        actorId: event.actorId,
      }),
      { enrich: false },
    );
    expect(
      JSON.stringify(vi.mocked(logger.structured).mock.calls),
    ).not.toContain('INJECT');
  });
  it('refuses unsigned/tampered and malformed input', async () => {
    expect(
      (await POST(request(undefined, { 'outline-signature': 'bad' }))).status,
    ).toBe(401);
    expect((await POST(request('not json'))).status).toBe(400);
    expect((await POST(request('{}'))).status).toBe(400);
  });
  it('does not buffer a declared oversized request', async () => {
    expect(
      (
        await POST(
          request(undefined, {
            'content-length': String(OUTLINE_WEBHOOK_MAX_BYTES + 1),
          }),
        )
      ).status,
    ).toBe(413);
  });
  it('stays unavailable until its signing secret is provisioned', async () => {
    delete process.env.AGENT_LCARS_OUTLINE_WEBHOOK_SECRET;
    expect((await POST(request())).status).toBe(503);
    expect(logger.structured).toHaveBeenCalledWith(
      'info',
      'Outline agent event received',
      expect.objectContaining({ outcome: 'disabled' }),
      { enrich: false },
    );
  });
});
