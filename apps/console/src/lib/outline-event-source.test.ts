import type {
  AgentEventSubscription,
  OutlineEventNotice,
  OutlineSourceJob,
} from '@agent-lcars/work';
import { describe, expect, it, vi } from 'vitest';

import { MemoryAgentEventSubscriptionStore } from './agent-event-store';
import {
  acceptOutlineSourceReport,
  normalizedOutlineEvent,
  outlineFallbackId,
  queueOutlineEvent,
  queueOutlineFallback,
} from './outline-event-source';
import type {
  OutlineDeliveryReceipt,
  OutlineDocumentObservation,
  OutlineEventStore,
} from './outline-event-store';

const id = '00000000-0000-4000-8000-000000000001';
const doc = '00000000-0000-4000-8000-000000000002';
const notice: OutlineEventNotice = {
  deliveryId: id,
  documentId: doc,
  objectId: '00000000-0000-4000-8000-000000000003',
  actorId: '00000000-0000-4000-8000-000000000004',
  event: 'comments.create',
  occurredAt: '2026-11-26T01:00:00Z',
};
function fixture() {
  const notices = new Map<string, OutlineEventNotice>([[id, notice]]);
  const documents = new Map<string, OutlineDocumentObservation>();
  const receipts = new Map<string, OutlineDeliveryReceipt>();
  const routed = new Set<string>();
  const store: OutlineEventStore = {
    saveNotice: async (n) => {
      notices.set(n.deliveryId, n);
    },
    notice: async (id) => notices.get(id),
    wasRouted: async (id) => routed.has(id),
    markRouted: async (id) => {
      routed.add(id);
    },
    observe: async (id, agentCreated) => {
      documents.set(id, {
        agentCreated,
        everSubscribed: documents.get(id)?.everSubscribed ?? false,
      });
    },
    document: async (id) => documents.get(id),
    subscribed: async (id) => {
      documents.set(id, {
        agentCreated: documents.get(id)?.agentCreated ?? false,
        everSubscribed: true,
      });
    },
    saveReceipt: async (r) => {
      receipts.set(r.deliveryId, r);
    },
    receipt: async (id) => receipts.get(id),
  };
  const subscriptions = new MemoryAgentEventSubscriptionStore();
  const publisher = {
    publish: vi.fn(
      async (_data: Buffer, _attributes: Record<string, string>) => 'pubsub-id',
    ),
  };
  const resumeWork = vi.fn(async () => ({
    outcome: 'queued' as const,
    runId: 'work:w/r2',
  }));
  const publish = vi.fn(async (_job: OutlineSourceJob) => undefined);
  const drain = vi.fn(async () => undefined);
  const deps = {
    store,
    routing: { store: subscriptions, publisher, resumeWork },
    enabled: true,
    publish,
    drain,
  };
  const subscribe = async (
    target: AgentEventSubscription['target'],
    kinds?: string[],
    until?: string,
  ) => {
    const s: AgentEventSubscription = {
      id: `sub-${target.type === 'session' ? target.host : target.workId}`,
      key: `outline:doc:${doc}`,
      source: 'outline:doc',
      target,
      createdAt: notice.occurredAt,
      ...(kinds ? { kinds } : {}),
      ...(until ? { until } : {}),
    };
    await subscriptions.create(s);
    return s;
  };
  return {
    notices,
    documents,
    receipts,
    subscriptions,
    store,
    publisher,
    resumeWork,
    publish,
    drain,
    deps,
    subscribe,
  };
}
const report = {
  noticeId: id,
  outcome: 'accepted' as const,
  agentCreated: true,
};

describe('Outline routing and fallback ownership', () => {
  it.each(['session', 'work'] as const)(
    'does not invent a fallback after a lost terminal %s report response',
    async (type) => {
      const f = fixture();
      await f.store.subscribed(doc);
      await f.subscribe(
        type === 'session'
          ? { type, host: 'pike', sessionId: 'a' }
          : { type, workId: 'w' },
        undefined,
        'comment',
      );
      await acceptOutlineSourceReport(report, f.deps);
      expect(await f.subscriptions.listForKey(`outline:doc:${doc}`)).toEqual(
        [],
      );
      // The successful response was lost. Signed intake can also repeat before
      // Pub/Sub's original job acknowledgment reached the service.
      await queueOutlineEvent(notice, f.store, async () => undefined);
      await acceptOutlineSourceReport(report, f.deps);
      expect(f.publish).not.toHaveBeenCalled();
      expect(
        type === 'session' ? f.publisher.publish : f.resumeWork,
      ).toHaveBeenCalledOnce();
    },
  );
  it('stores only signed identifiers before queueing the existing source host', async () => {
    const f = fixture();
    await queueOutlineEvent(notice, f.store, f.publish);
    expect(f.notices.get(id)).toEqual(notice);
    expect(f.publish).toHaveBeenCalledWith({ type: 'outline-event', notice });
  });
  it('records positive creator evidence in shadow without routing or fallback', async () => {
    const f = fixture();
    f.deps.enabled = false;
    await f.subscribe({
      type: 'session',
      host: 'laforge',
      sessionId: 'session-a',
    });
    await acceptOutlineSourceReport(report, f.deps);
    expect(f.documents.get(doc)).toEqual({
      agentCreated: true,
      everSubscribed: false,
    });
    expect(f.publisher.publish).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('routes to both hosts and native Work, with receipts only for session delivery', async () => {
    const f = fixture();
    await f.subscribe({ type: 'session', host: 'pike', sessionId: 'a' });
    await f.subscribe({ type: 'session', host: 'laforge', sessionId: 'b' });
    await f.subscribe({ type: 'work', workId: 'w' });
    expect((await acceptOutlineSourceReport(report, f.deps)).delivered).toBe(3);
    expect(
      f.publisher.publish.mock.calls.map(([, a]) => a.host).sort(),
    ).toEqual(['laforge', 'pike']);
    expect(f.receipts.size).toBe(2);
    expect(f.resumeWork).toHaveBeenCalledTimes(1);
    expect(f.drain).toHaveBeenCalledTimes(1);
    const repeated = await acceptOutlineSourceReport(report, f.deps);
    expect(repeated.delivered).toBe(0);
    expect(f.publisher.publish).toHaveBeenCalledTimes(2);
    expect(f.resumeWork).toHaveBeenCalledTimes(1);
  });
  it('refuses an unknown source notice and does not fabricate creator evidence', async () => {
    const f = fixture();
    f.notices.clear();
    await expect(acceptOutlineSourceReport(report, f.deps)).rejects.toThrow(
      'unknown',
    );
    expect(f.documents.size).toBe(0);
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });
  it.each([
    'own-change',
    'untrusted-actor',
    'foreign-document',
    'no-text-change',
  ] as const)('does not route %s', async (outcome) => {
    const f = fixture();
    await f.subscribe({ type: 'session', host: 'pike', sessionId: 'a' });
    await acceptOutlineSourceReport({ ...report, outcome }, f.deps);
    expect(f.publisher.publish).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('cannot report a delivery addressed to another host', async () => {
    const f = fixture();
    await f.subscribe({ type: 'session', host: 'laforge', sessionId: 'b' });
    await acceptOutlineSourceReport(report, f.deps);
    const deliveryId = [...f.receipts.keys()][0];
    expect(
      await queueOutlineFallback(deliveryId, 'pike', f.store, f.publish),
    ).toBe(false);
    expect(f.publish).not.toHaveBeenCalled();
    expect(
      await queueOutlineFallback(deliveryId, 'laforge', f.store, f.publish),
    ).toBe(true);
    expect(f.publish).toHaveBeenCalledWith({
      type: 'outline-fallback',
      id: outlineFallbackId(deliveryId),
      documentId: doc,
      parentCommentId: notice.objectId,
    });
  });
  it('falls back only for a previously subscribed document with nobody still subscribed', async () => {
    const f = fixture();
    await acceptOutlineSourceReport(report, f.deps);
    expect(f.publish).not.toHaveBeenCalled();
    await f.store.subscribed(doc);
    await acceptOutlineSourceReport(report, f.deps);
    expect(f.publish).toHaveBeenCalledOnce();
  });
  it('respects intentional kind filters without writing an unsolicited fallback', async () => {
    const f = fixture();
    await f.store.observe(doc, true);
    await f.store.subscribed(doc);
    await f.subscribe({ type: 'session', host: 'pike', sessionId: 'a' }, [
      'edit',
    ]);
    await acceptOutlineSourceReport(report, f.deps);
    expect(f.publisher.publish).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('retries a failed publish with the same receipt and delivery id', async () => {
    const f = fixture();
    await f.subscribe({ type: 'session', host: 'pike', sessionId: 'a' });
    f.publisher.publish.mockRejectedValueOnce(new Error('transport'));
    await expect(acceptOutlineSourceReport(report, f.deps)).rejects.toThrow(
      'failed',
    );
    const receiptId = [...f.receipts.keys()][0];
    await acceptOutlineSourceReport(report, f.deps);
    expect([...f.receipts.keys()]).toEqual([receiptId]);
    expect(
      f.publisher.publish.mock.calls.map(([, a]) => a.delivery_id),
    ).toEqual([receiptId, receiptId]);
  });
  it('constructs links and event ids only from validated metadata', () => {
    expect(normalizedOutlineEvent(notice)).toEqual({
      id: `outline.${id}`,
      key: `outline:doc:${doc}`,
      kind: 'comment',
      occurredAt: notice.occurredAt,
      actor: notice.actorId,
      link: `https://outline.lan.jlapenna.net/doc/${doc}?commentId=${notice.objectId}`,
    });
  });
});
