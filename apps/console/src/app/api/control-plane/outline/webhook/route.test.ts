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
  vi.useRealTimers();
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
  it('rejects missing, malformed and stale signature headers before reading', async () => {
    const missing = request();
    missing.headers.delete('outline-signature');
    const malformed = request(undefined, { 'outline-signature': 'bad' });
    const stale = request(undefined, {
      'outline-signature': `t=${Date.now() - 6 * 60_000},s=${'a'.repeat(64)}`,
    });
    for (const delivery of [missing, malformed, stale]) {
      expect((await POST(delivery)).status).toBe(401);
      expect(delivery.bodyUsed).toBe(false);
    }
  });

  function heldDelivery() {
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const body = JSON.stringify(event);
    const delivery = new Request(request(body), {
      body: stream.readable,
      duplex: 'half',
    } as RequestInit);
    let sent: Promise<void> | undefined;
    return {
      delivery,
      response: POST(delivery),
      send: () =>
        (sent ??= writer.write(Buffer.from(body)).then(() => writer.close())),
    };
  }

  it('records a ten-delivery burst while waiting bodies stay unread', async () => {
    const deliveries = Array.from({ length: 10 }, heldDelivery);
    try {
      await Promise.resolve();
      expect(deliveries.map(({ delivery }) => delivery.bodyUsed)).toEqual([
        true,
        true,
        ...Array<boolean>(8).fill(false),
      ]);

      const excess = request();
      const response = await POST(excess);
      expect(response.status).toBe(503);
      expect(excess.bodyUsed).toBe(false);
    } finally {
      await Promise.all(deliveries.map(({ send }) => send()));
    }
    const results = await Promise.all(
      deliveries.map(({ response }) => response),
    );
    expect(results.map(({ status }) => status)).toEqual(
      Array<number>(10).fill(200),
    );
  });

  it('expires queued deliveries without consuming a slot or reading the body', async () => {
    vi.useFakeTimers();
    const first = heldDelivery();
    const second = heldDelivery();
    try {
      const waiting = request();
      const pending = POST(waiting);
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await pending).status).toBe(503);
      expect(waiting.bodyUsed).toBe(false);

      const next = POST(request());
      await first.send();
      expect((await next).status).toBe(200);
    } finally {
      await Promise.allSettled([
        first.send(),
        second.send(),
        first.response,
        second.response,
      ]);
    }
  });

  it('drops a disconnected waiter and admits the next delivery', async () => {
    const first = heldDelivery();
    const second = heldDelivery();
    const controller = new AbortController();
    const abandoned = new Request(request(), { signal: controller.signal });
    try {
      const pending = POST(abandoned);
      const next = POST(request());
      controller.abort();
      expect((await pending).status).toBe(503);
      expect(abandoned.bodyUsed).toBe(false);
      await first.send();
      expect((await next).status).toBe(200);
    } finally {
      await Promise.allSettled([
        first.send(),
        second.send(),
        first.response,
        second.response,
      ]);
    }
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
  it('rejects a signed delivery in maintenance mode before observing it', async () => {
    vi.stubEnv('MAINTENANCE_MODE', 'true');
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('System is under maintenance.');
    expect(logger.structured).not.toHaveBeenCalled();
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
