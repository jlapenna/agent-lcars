import type { Firestore } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./inbox-notifications-data', () => ({
  loadNotificationSnapshotFor: vi.fn(),
}));
vi.mock('./orchestrator-runtime', () => ({
  createOrchestratorRuntime: vi.fn(),
}));

import type { InboxNotificationSnapshot } from './inbox-notifications';
import {
  INBOX_PUSH_SEND_OPTIONS,
  InboxPushStore,
  pushSubscriptionSchema,
} from './inbox-push';

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test',
  keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
};
function snapshot(time: number, ids = ['old']): InboxNotificationSnapshot {
  return {
    principalId: 'user',
    observedAt: time,
    available: true,
    sourceTimes: { queue: time, activity: time, native: time },
    decisions: ids.map((id) => ({ id, generation: 'park' })),
  };
}
function fixture() {
  const docs = new Map<string, unknown>();
  let tail = Promise.resolve();
  const firestore = {
    collection: () => ({
      doc: (id: string) => ({
        id,
        get: async () => ({ data: () => structuredClone(docs.get(id)) }),
      }),
    }),
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) => {
      const result = tail.then(() =>
        fn({
          get: async (ref: { id: string }) => ({
            data: () => structuredClone(docs.get(ref.id)),
          }),
          set: (ref: { id: string }, data: unknown) => {
            docs.set(ref.id, structuredClone(data));
          },
        }),
      );
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  } as unknown as Firestore;
  const store = new InboxPushStore(firestore);
  const revision = () =>
    (
      Array.from(docs.values())[0] as {
        browsers: Record<string, { revision: string }>;
      }
    ).browsers;
  return { store, revision: () => Object.values(revision())[0].revision };
}
async function subscribe(store: InboxPushStore, now: number) {
  const revision = await store.begin('user', 'login', subscription);
  await store.activate('user', subscription.endpoint, revision, snapshot(now));
}
describe('durable Inbox push delivery', () => {
  it('sends a short-lived notice with high urgency so idle devices wake for it', () => {
    expect(INBOX_PUSH_SEND_OPTIONS).toMatchObject({ TTL: 60, urgency: 'high' });
  });
  it('a server activation still running after its tab closes cannot undo revoke', async () => {
    const { store } = fixture();
    const revision = await store.begin('user', 'login', subscription);
    await store.remove('user', subscription.endpoint);
    await expect(
      store.activate(
        'user',
        subscription.endpoint,
        revision,
        snapshot(Date.now()),
      ),
    ).rejects.toThrow('superseded');
    expect(await store.status('user', subscription.endpoint)).toBe(false);
  });
  it('rejects arbitrary URLs and malformed browser key material', () => {
    expect(pushSubscriptionSchema.safeParse(subscription).success).toBe(true);
    for (const endpoint of [
      'http://fcm.googleapis.com/x',
      'https://localhost/x',
      'https://fcm.googleapis.com.evil.test/x',
      'https://user@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
    ])
      expect(
        pushSubscriptionSchema.safeParse({ ...subscription, endpoint }).success,
      ).toBe(false);
  });
  it('baselines quietly, consumes one attempt across overlapping ticks, and honors revoke', async () => {
    const { store, revision } = fixture();
    const now = Date.now();
    await subscribe(store, now);
    const rev = revision();
    expect(
      await store.claim(
        'user',
        subscription.endpoint,
        rev,
        snapshot(now + 1),
        now + 1,
      ),
    ).toBeUndefined();
    const fresh = snapshot(now + 2, ['old', 'new']);
    const claims = await Promise.all(
      [1, 2].map(() =>
        store.claim('user', subscription.endpoint, rev, fresh, now + 2),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(JSON.stringify(claims.find(Boolean)).length).toBeLessThan(250);
    vi.spyOn(Date, 'now').mockReturnValue(now + 3);
    expect(await store.receive('user', subscription.endpoint, now + 2)).toEqual(
      [{ id: 'new', generation: 'park' }],
    );
    expect(
      await store.receive('user', subscription.endpoint, now + 2),
    ).toBeUndefined();
    vi.restoreAllMocks();
    await store.remove('user', subscription.endpoint);
    expect(
      await store.claim(
        'user',
        subscription.endpoint,
        rev,
        snapshot(now + 3, ['later']),
        now + 3,
      ),
    ).toBeUndefined();
  });
  it('drops resolved pending decisions, refuses stale sources and fences renewed consent', async () => {
    const { store, revision } = fixture();
    const now = Date.now();
    await subscribe(store, now);
    const rev = revision();
    await store.claim(
      'user',
      subscription.endpoint,
      rev,
      snapshot(now + 1, ['first']),
      now + 1,
    );
    expect(
      await store.claim(
        'user',
        subscription.endpoint,
        rev,
        snapshot(now + 2, ['pending']),
        now + 2,
      ),
    ).toBeUndefined();
    expect(
      await store.claim(
        'user',
        subscription.endpoint,
        rev,
        snapshot(now + 60002, []),
        now + 60002,
      ),
    ).toBeUndefined();
    expect(
      await store.claim(
        'user',
        subscription.endpoint,
        rev,
        snapshot(now, ['stale']),
        now + 60002,
      ),
    ).toBeUndefined();
    await subscribe(store, now);
    expect(
      await store.claim(
        'user',
        subscription.endpoint,
        rev,
        snapshot(now + 4, ['new']),
        now + 4,
      ),
    ).toBeUndefined();
    await store.remove('user', subscription.endpoint, rev);
    expect(await store.status('user', subscription.endpoint)).toBe(true);
  });
});
