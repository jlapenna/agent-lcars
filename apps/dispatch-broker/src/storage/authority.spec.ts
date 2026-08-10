import { describe, expect, test } from 'vitest';

import { createLedger } from '../broker.js';
import {
  acquireAuthority,
  persistAuthority,
  releaseAuthority,
  TaskLeaseBusyError,
} from './authority.js';
import { InMemoryStoragePort } from './in-memory-port.js';

const task = {
  repositoryId: 1307149765,
  repository: 'jlapenna/agent-lcars',
  issue: 736,
};

describe('storage authority lease', () => {
  test('seeds exact controller state and releases without losing it', async () => {
    const port = new InMemoryStoragePort();
    const ledger = createLedger(task, '2026-08-08T06:00:00.000Z');
    const acquired = await acquireAuthority(
      port,
      task,
      'delivery:one',
      ledger,
      {
        now: () => '2026-08-08T06:01:00.000Z',
      },
    );

    expect(acquired.ledger).toEqual(ledger);
    expect((await port.readTask(task))?.lease?.owner).toBe('delivery:one');

    acquired.ledger.control.closed = true;
    await persistAuthority(
      acquired.session,
      acquired.ledger,
      '2026-08-08T06:02:00.000Z',
    );
    await releaseAuthority(
      acquired.session,
      acquired.ledger,
      '2026-08-08T06:03:00.000Z',
    );

    const stored = await port.readTask(task);
    expect(stored?.lease).toBeUndefined();
    expect(stored?.controllerState?.control.closed).toBe(true);
  });

  test('rejects another live owner and allows takeover after expiry', async () => {
    const port = new InMemoryStoragePort();
    const ledger = createLedger(task, '2026-08-08T06:00:00.000Z');
    await acquireAuthority(port, task, 'delivery:one', ledger, {
      now: () => '2026-08-08T06:01:00.000Z',
      leaseMs: 1_000,
    });

    await expect(
      acquireAuthority(port, task, 'delivery:two', ledger, {
        now: () => '2026-08-08T06:01:00.500Z',
      }),
    ).rejects.toBeInstanceOf(TaskLeaseBusyError);

    const takeover = await acquireAuthority(
      port,
      task,
      'delivery:two',
      ledger,
      {
        now: () => '2026-08-08T06:01:02.000Z',
      },
    );
    expect(takeover.session.owner).toBe('delivery:two');
  });

  test('same owner can renew its lease idempotently', async () => {
    const port = new InMemoryStoragePort();
    const ledger = createLedger(task, '2026-08-08T06:00:00.000Z');
    const first = await acquireAuthority(port, task, 'delivery:one', ledger, {
      now: () => '2026-08-08T06:01:00.000Z',
    });
    const second = await acquireAuthority(port, task, 'delivery:one', ledger, {
      now: () => '2026-08-08T06:02:00.000Z',
    });

    expect(second.session.lease.acquiredAt).toBe(
      first.session.lease.acquiredAt,
    );
    expect(second.session.lease.expiresAt).toBe('2026-08-08T06:04:00.000Z');
  });

  test('waits for a transient live lease and acquires after it expires', async () => {
    const port = new InMemoryStoragePort();
    const ledger = createLedger(task, '2026-08-08T06:00:00.000Z');
    await acquireAuthority(port, task, 'delivery:one', ledger, {
      now: () => '2026-08-08T06:01:00.000Z',
      leaseMs: 1_000,
    });
    let observedMs = Date.parse('2026-08-08T06:01:00.250Z');
    let waits = 0;

    const acquired = await acquireAuthority(
      port,
      task,
      'delivery:two',
      ledger,
      {
        now: () => new Date(observedMs).toISOString(),
        busyWaitMs: 5_000,
        sleep: async (ms) => {
          waits += 1;
          observedMs += ms;
        },
      },
    );

    expect(waits).toBeGreaterThan(0);
    expect(acquired.session.owner).toBe('delivery:two');
  });

  test.each([
    {
      name: 'an empty compatibility projection',
      state: { signals: [], intents: [] },
    },
    {
      name: 'terminal compatibility history',
      state: {
        signals: [],
        intents: [
          {
            intentId: 'intent-1',
            sourceId: 'source-1',
            occurredAt: '2026-08-08T05:00:00.000Z',
            state: 'completed' as const,
          },
        ],
      },
    },
    {
      name: 'an active compatibility intent',
      state: {
        desiredIntentId: 'intent-1',
        signals: [],
        intents: [
          {
            intentId: 'intent-1',
            sourceId: 'source-1',
            occurredAt: '2026-08-08T05:00:00.000Z',
            state: 'active' as const,
          },
        ],
      },
    },
  ])(
    'fails closed uniformly for $name, regardless of age',
    async ({ state }) => {
      const port = new InMemoryStoragePort();
      await port.writeTask(task, undefined, state);

      await expect(
        acquireAuthority(
          port,
          task,
          'delivery:migration-check',
          createLedger(task),
        ),
      ).rejects.toMatchObject({
        name: 'AuthorityStateMissingError',
      });
    },
  );
});
