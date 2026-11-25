import type { AgentEventSubscription } from '@agent-lcars/work';
import { Firestore } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';

import {
  type AgentEventSubscriptionStore,
  FirestoreAgentEventSubscriptionStore,
  MemoryAgentEventSubscriptionStore,
} from './agent-event-store';

function subscription(
  id: string,
  overrides: Partial<AgentEventSubscription> = {},
): AgentEventSubscription {
  return {
    id,
    key: 'lcars:session:watched',
    source: 'lcars:session',
    target: { type: 'session', sessionId: 'session-a', host: 'pike' },
    createdAt: '2026-11-25T11:00:00.000Z',
    ...overrides,
  };
}

const emulatorHost = process.env['FIRESTORE_EMULATOR_HOST'];
if (process.env['REQUIRE_FIRESTORE_EMULATOR'] === '1' && !emulatorHost)
  throw new Error('Firestore emulator required');

const stores: [string, (() => AgentEventSubscriptionStore) | undefined][] = [
  ['memory', () => new MemoryAgentEventSubscriptionStore()],
  [
    'Firestore',
    emulatorHost
      ? () => {
          const firestore = new Firestore({
            projectId: `demo-agent-events-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            host: emulatorHost,
            ssl: false,
          });
          return new FirestoreAgentEventSubscriptionStore(() => firestore);
        }
      : undefined,
  ],
];

describe.each(stores)('%s agent event subscription store', (_name, make) => {
  it.skipIf(make === undefined)(
    'creates once and returns the stored subscription on a repeat',
    async () => {
      const store = make!();
      const first = subscription('a', { kinds: ['ended'], until: 'ended' });
      expect(await store.create(first)).toEqual({
        subscription: first,
        created: true,
      });
      const repeat = await store.create({
        ...first,
        createdAt: '2026-11-25T12:00:00.000Z',
      });
      expect(repeat).toEqual({ subscription: first, created: false });
      expect(await store.get('a')).toEqual(first);
      // No optional field is stored as undefined.
      expect(await store.get('a')).not.toHaveProperty('routedEventIds');
      expect(await store.get('missing')).toBeUndefined();
    },
  );

  it.skipIf(make === undefined)(
    'queries by host, session and key',
    async () => {
      const store = make!();
      await store.create(subscription('a'));
      await store.create(
        subscription('b', {
          key: 'lcars:session:other',
          target: { type: 'session', sessionId: 'session-b', host: 'pike' },
        }),
      );
      await store.create(
        subscription('c', {
          target: { type: 'session', sessionId: 'session-c', host: 'laforge' },
        }),
      );
      await store.create(
        subscription('w', { target: { type: 'work', workId: 'W1' } }),
      );
      const ids = (list: AgentEventSubscription[]) =>
        list.map(({ id }) => id).sort();
      expect(ids(await store.listForHost('pike'))).toEqual(['a', 'b']);
      expect(ids(await store.listForHost('pike', 'session-b'))).toEqual(['b']);
      expect(ids(await store.listForHost('pike', 'session-c'))).toEqual([]);
      expect(ids(await store.listForKey('lcars:session:watched'))).toEqual([
        'a',
        'c',
        'w',
      ]);
      expect(await store.countForSession('session-a')).toBe(1);
      expect(await store.countForSession('session-z')).toBe(0);
      expect(ids(await store.listForWork('W1'))).toEqual(['w']);
      expect(ids(await store.listForWork('W2'))).toEqual([]);
    },
  );

  it.skipIf(make === undefined)(
    'records routed events and removes an ended subscription',
    async () => {
      const store = make!();
      await store.create(subscription('a'));
      await store.settleRouted('a', 'event-1', false);
      await store.settleRouted('a', 'event-2', false);
      await store.settleRouted('a', 'event-1', false);
      expect((await store.get('a'))?.routedEventIds).toEqual([
        'event-2',
        'event-1',
      ]);
      await store.settleRouted('a', 'event-3', true);
      expect(await store.get('a')).toBeUndefined();
      // A removed subscription stays removed.
      await store.settleRouted('a', 'event-4', false);
      expect(await store.get('a')).toBeUndefined();
    },
  );

  it.skipIf(make === undefined)(
    'reports whether a delete removed anything',
    async () => {
      const store = make!();
      await store.create(subscription('a'));
      expect(await store.delete('a')).toBe(true);
      expect(await store.delete('a')).toBe(false);
    },
  );
});
