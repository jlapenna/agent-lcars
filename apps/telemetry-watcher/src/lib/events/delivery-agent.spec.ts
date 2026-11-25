import { describe, expect, it, vi } from 'vitest';

import type { DeliveredStore } from './delivered-store';
import {
  DeliveryAgent,
  type DeliveryAgentDependencies,
  type InboundDelivery,
} from './delivery-agent';
import type { HerdrSendResult } from './herdr-core-send';
import { DeliveryMetrics } from './metrics';
import type { TargetCheck } from './terminal-target';
import {
  DELIVERY_ID,
  deliveryBody,
  deliveryMessage,
  HOST,
  SESSION,
} from './test-fixtures';

const PUBLISHED = Date.parse('2026-11-25T12:00:00.000Z');
const READY: TargetCheck = { kind: 'ready', address: 't36', turn: 4 };
const WORKING: TargetCheck = {
  kind: 'busy',
  address: 't36',
  turn: 4,
  status: 'working',
};
const BLOCKED: TargetCheck = { ...WORKING, status: 'blocked' };
const STARTED: TargetCheck = { ...WORKING, turn: 4 };
const ADVANCED: TargetCheck = { kind: 'ready', address: 't36', turn: 5 };

interface Harness {
  agent: DeliveryAgent;
  deps: DeliveryAgentDependencies;
  metrics: DeliveryMetrics;
  logs: Record<string, unknown>[];
  sent: string[];
  recorded: Map<string, number>;
  onUndeliverable: ReturnType<typeof vi.fn>;
  clock: { t: number };
}

/** A fake clock that sleeping advances, a scripted terminal, and fakes for
 * everything else. The last scripted check repeats. */
function harness(
  checks: TargetCheck[],
  sends: HerdrSendResult[] = [{ kind: 'sent', started: true }],
  overrides: Partial<DeliveryAgentDependencies> = {},
): Harness {
  const clock = { t: PUBLISHED + 2_000 };
  const metrics = new DeliveryMetrics();
  const logs: Record<string, unknown>[] = [];
  const sent: string[] = [];
  const recorded = new Map<string, number>();
  const delivered: DeliveredStore = {
    has: (id) => recorded.has(id),
    record: (id, at) => recorded.set(id, at),
  };
  let check = 0;
  let send = 0;
  const onUndeliverable = vi.fn(async () => undefined);
  const deps: DeliveryAgentDependencies = {
    host: HOST,
    checkTarget: vi.fn(async (sessionId: string) => {
      expect(sessionId).toBe(SESSION);
      return checks[Math.min(check++, checks.length - 1)];
    }),
    send: vi.fn(async (address: string, text: string) => {
      expect(address).toBe('t36');
      sent.push(text);
      return sends[Math.min(send++, sends.length - 1)];
    }),
    delivered,
    onUndeliverable,
    metrics,
    log: (record) => logs.push(record),
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    ...overrides,
  };
  return {
    agent: new DeliveryAgent(deps),
    deps,
    metrics,
    logs,
    sent,
    recorded,
    onUndeliverable,
    clock,
  };
}

function inbound(message = deliveryMessage()): InboundDelivery & {
  ack: ReturnType<typeof vi.fn>;
  nack: ReturnType<typeof vi.fn>;
} {
  return {
    ...message,
    publishTime: new Date(PUBLISHED),
    ack: vi.fn(async () => undefined),
    nack: vi.fn(async () => undefined),
  };
}

describe('DeliveryAgent', () => {
  it('types the locally rendered notice into an idle session, then acks', async () => {
    const h = harness([READY]);
    const message = inbound();
    expect(await h.agent.handle(message)).toBe('delivered');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain(
      '[lcars-event] lcars:session:other-session ended',
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.nack).not.toHaveBeenCalled();
    expect(h.recorded.has(DELIVERY_ID)).toBe(true);
    expect(h.metrics.deliveries.get('delivered')).toBe(1);
    expect(h.metrics.render()).toContain(
      'lcars_events_agent_delivery_latency_seconds_bucket{le="5"} 1',
    );
    expect(h.metrics.inFlight).toBe(0);
  });

  it('never logs the notice', async () => {
    const h = harness([READY]);
    await h.agent.handle(inbound());
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain('[lcars-event]');
    expect(text).not.toContain('https://');
    expect(h.logs.at(-1)).toMatchObject({
      msg: 'delivered',
      deliveryId: DELIVERY_ID,
      sessionId: SESSION,
      key: 'lcars:session:other-session',
      kind: 'ended',
    });
  });

  it('waits with backoff while the session works or sits on an approval prompt', async () => {
    const h = harness([WORKING, BLOCKED, WORKING, READY]);
    const message = inbound();
    expect(await h.agent.handle(message)).toBe('delivered');
    expect(h.sent).toHaveLength(1);
    // 2 s, 4 s, 8 s of backoff before the session was free.
    expect(h.clock.t - (PUBLISHED + 2_000)).toBe(14_000);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('releases the delivery to Pub/Sub when the session stays busy past the hold', async () => {
    const h = harness([WORKING], [], {
      options: { holdMs: 60_000 },
    });
    const message = inbound();
    expect(await h.agent.handle(message)).toBe('retried');
    expect(h.sent).toHaveLength(0);
    expect(message.nack).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(h.recorded.size).toBe(0);
    expect(h.metrics.deliveries.get('retried')).toBe(1);
    expect(h.logs.at(-1)).toMatchObject({ reason: 'busy-working' });
  });

  it('retries later when herdr-core does not answer', async () => {
    const h = harness([{ kind: 'unavailable' }], [], {
      options: { holdMs: 10_000 },
    });
    const message = inbound();
    expect(await h.agent.handle(message)).toBe('retried');
    expect(message.nack).toHaveBeenCalledTimes(1);
  });

  it('waits again when hc refuses because the session went busy', async () => {
    const h = harness(
      [READY, WORKING, READY],
      [
        { kind: 'refused', error: 'blocked' },
        { kind: 'sent', started: true },
      ],
    );
    expect(await h.agent.handle(inbound())).toBe('delivered');
    expect(h.sent).toHaveLength(2);
  });

  it('confirms the turn by polling when hc cannot tell it started', async () => {
    const h = harness(
      [READY, READY, ADVANCED],
      [{ kind: 'sent', started: null }],
    );
    expect(await h.agent.handle(inbound())).toBe('delivered');
    expect(h.sent).toHaveLength(1);
  });

  it.each([
    ['went to work', STARTED],
    ['opened an approval dialog', BLOCKED],
  ])('counts a turn as started when the session %s', async (_name, after) => {
    const h = harness([READY, after], [{ kind: 'sent', started: false }]);
    expect(await h.agent.handle(inbound())).toBe('delivered');
  });

  it('types once more when the first notice started no turn', async () => {
    const h = harness(
      [READY],
      [
        { kind: 'sent', started: false },
        { kind: 'sent', started: true },
      ],
    );
    expect(await h.agent.handle(inbound())).toBe('delivered');
    expect(h.sent).toHaveLength(2);
    expect(h.logs.at(-1)).toMatchObject({ attempt: 2 });
  });

  it('gives up after two notices that start no turn', async () => {
    const h = harness([READY], [{ kind: 'sent', started: false }]);
    const message = inbound();
    expect(await h.agent.handle(message)).toBe('undeliverable');
    expect(h.sent).toHaveLength(2);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(h.metrics.undeliverable.get('turn-not-started')).toBe(1);
  });

  it('acks a delivery to a session that is gone and hands it to the fallback', async () => {
    const h = harness([{ kind: 'gone', reason: 'foreground-changed' }]);
    const message = inbound();
    expect(await h.agent.handle(message)).toBe('undeliverable');
    expect(h.sent).toHaveLength(0);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(h.onUndeliverable).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: DELIVERY_ID, sessionId: SESSION }),
      'foreground-changed',
    );
    expect(h.recorded.has(DELIVERY_ID)).toBe(true);
    expect(h.metrics.deliveries.get('undeliverable')).toBe(1);
  });

  it('still acks when the fallback fails', async () => {
    const h = harness([{ kind: 'gone', reason: 'session-ended' }], [], {
      onUndeliverable: async () => {
        throw new Error('outline down');
      },
    });
    const message = inbound();
    expect(await h.agent.handle(message)).toBe('undeliverable');
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(
      h.logs.some((log) => log['msg'] === 'undeliverable fallback failed'),
    ).toBe(true);
  });

  it('treats a terminal that disappears at send time as undeliverable', async () => {
    const h = harness([READY], [{ kind: 'gone', error: 'finished' }]);
    expect(await h.agent.handle(inbound())).toBe('undeliverable');
    expect(h.metrics.undeliverable.get('terminal-gone')).toBe(1);
  });

  it('releases the delivery when hc itself fails', async () => {
    const h = harness([READY], [{ kind: 'failed', error: 'exit_null' }]);
    const message = inbound();
    expect(await h.agent.handle(message)).toBe('retried');
    expect(message.nack).toHaveBeenCalledTimes(1);
    expect(h.logs.at(-1)).toMatchObject({ reason: 'send-exit_null' });
  });

  it('acks an invalid delivery without typing anything', async () => {
    const h = harness([READY]);
    const message = inbound(
      deliveryMessage(deliveryBody(), {
        host: 'laforge',
        delivery_id: DELIVERY_ID,
      }),
    );
    expect(await h.agent.handle(message)).toBe('invalid');
    expect(h.deps.checkTarget).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(h.logs.at(-1)).toMatchObject({ reason: 'wrong-host' });
  });

  it('drops a delivery id it already finished', async () => {
    const h = harness([READY]);
    await h.agent.handle(inbound());
    const repeat = inbound();
    expect(await h.agent.handle(repeat)).toBe('duplicate');
    expect(h.sent).toHaveLength(1);
    expect(repeat.ack).toHaveBeenCalledTimes(1);
    expect(h.metrics.deliveries.get('duplicate')).toBe(1);
  });

  it('serializes deliveries to one session, so a repeat arriving meanwhile is dropped', async () => {
    const h = harness([WORKING, READY]);
    const [first, second] = await Promise.all([
      h.agent.handle(inbound()),
      h.agent.handle(inbound()),
    ]);
    expect([first, second]).toEqual(['delivered', 'duplicate']);
    expect(h.sent).toHaveLength(1);
  });

  it('survives an ack that Pub/Sub rejects', async () => {
    const h = harness([READY]);
    const message = inbound();
    message.ack.mockRejectedValueOnce(new Error('invalid ack id'));
    expect(await h.agent.handle(message)).toBe('delivered');
    expect(h.logs.at(-1)).toMatchObject({ msg: 'ack failed' });
  });
});
