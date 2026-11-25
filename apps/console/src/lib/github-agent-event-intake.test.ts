import {
  agentEventDeliverySchema,
  type AgentEventSubscription,
} from '@agent-lcars/work';
import { describe, expect, it, vi } from 'vitest';

import { MemoryAgentEventSubscriptionStore } from './agent-event-store';
import {
  type GithubAgentEventReads,
  queueGithubAgentEvents,
  routeGithubAgentEvents,
} from './github-agent-event-intake';

const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
const SHA = 'c'.repeat(40);
const KEY = 'github:pr:jlapenna/homelab#7';
const repository = {
  full_name: 'jlapenna/homelab',
  html_url: 'https://github.com/jlapenna/homelab',
};

function subscription(
  id: string,
  overrides: Partial<AgentEventSubscription> = {},
): AgentEventSubscription {
  return {
    id,
    key: KEY,
    source: 'github:pr',
    target: { type: 'session', sessionId: `session-${id}`, host: 'pike' },
    createdAt: '2026-11-25T11:00:00.000Z',
    ...overrides,
  };
}

function review(login: string, association: string) {
  return {
    action: 'submitted',
    repository,
    review: {
      state: 'APPROVED',
      html_url:
        'https://github.com/jlapenna/homelab/pull/7#pullrequestreview-1',
      user: { login },
      author_association: association,
      submitted_at: '2026-11-25T11:30:00Z',
    },
    pull_request: {
      number: 7,
      html_url: 'https://github.com/jlapenna/homelab/pull/7',
    },
  };
}

function checkRun(deliveryId = DELIVERY) {
  return {
    event: 'check_run',
    deliveryId,
    receivedAt: '2026-11-25T12:00:00.000Z',
    payload: {
      action: 'completed',
      repository,
      check_run: {
        head_sha: SHA,
        completed_at: '2026-11-25T11:58:00Z',
        pull_requests: [{ number: 7, head: { sha: SHA } }],
      },
    },
  };
}

function threadResolved() {
  return {
    event: 'pull_request_review_thread',
    deliveryId: DELIVERY,
    receivedAt: '2026-11-25T12:00:00.000Z',
    payload: {
      action: 'resolved',
      repository,
      sender: { login: 'jlapenna' },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/jlapenna/homelab/pull/7',
        user: { login: 'agent-lcars[bot]' },
        author_association: 'NONE',
      },
    },
  };
}

async function setup(
  subscriptions: AgentEventSubscription[],
  reads: Partial<GithubAgentEventReads> = {},
) {
  const store = new MemoryAgentEventSubscriptionStore();
  for (const s of subscriptions) await store.create(s);
  const listForKey = vi.spyOn(store, 'listForKey');
  let n = 0;
  const publish = vi.fn(async () => `message-${++n}`);
  const checkRuns = vi.fn(reads.checkRuns ?? (async () => []));
  const threadsResolved = vi.fn(reads.threadsResolved ?? (async () => true));
  return {
    store,
    listForKey,
    publish,
    checkRuns,
    threadsResolved,
    deps: {
      store,
      publisher: { publish },
      reads: { checkRuns, threadsResolved },
    },
  };
}

function notices(publish: ReturnType<typeof vi.fn>) {
  return publish.mock.calls.map(
    ([data]) =>
      agentEventDeliverySchema.parse(
        JSON.parse((data as Buffer).toString('utf8')),
      ).event,
  );
}

describe('routeGithubAgentEvents', () => {
  it('routes a trusted review to the key’s subscribers with one lookup', async () => {
    const { deps, publish, listForKey } = await setup([
      subscription('a'),
      subscription('b', { kinds: ['merged'] }),
    ]);
    const result = await routeGithubAgentEvents(
      {
        event: 'pull_request_review',
        deliveryId: DELIVERY,
        receivedAt: '2026-11-25T12:00:00.000Z',
        payload: review('jlapenna', 'OWNER'),
      },
      deps,
    );
    expect(listForKey).toHaveBeenCalledTimes(1);
    expect(result.events).toEqual([
      {
        key: KEY,
        kind: 'review',
        outcome: 'routed',
        eventId: `github.${DELIVERY}.review`,
        published: 1,
      },
    ]);
    expect(notices(publish)).toEqual([
      {
        id: `github.${DELIVERY}.review`,
        key: KEY,
        kind: 'review',
        actor: 'jlapenna',
        detail: 'approved',
        link: 'https://github.com/jlapenna/homelab/pull/7#pullrequestreview-1',
        occurredAt: '2026-11-25T11:30:00Z',
      },
    ]);
  });

  it('routes nothing, and reads nothing, for a review from outside the allowed associations', async () => {
    const { deps, publish, listForKey } = await setup([subscription('a')]);
    const result = await routeGithubAgentEvents(
      {
        event: 'pull_request_review',
        deliveryId: DELIVERY,
        receivedAt: '2026-11-25T12:00:00.000Z',
        payload: review('drive-by', 'CONTRIBUTOR'),
      },
      deps,
    );
    expect(result.events).toEqual([]);
    expect(listForKey).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('is idempotent per delivery: a redelivery publishes nothing more', async () => {
    const { deps, publish } = await setup([subscription('a')]);
    const delivery = {
      event: 'pull_request_review',
      deliveryId: DELIVERY,
      receivedAt: '2026-11-25T12:00:00.000Z',
      payload: review('jlapenna', 'OWNER'),
    };
    await routeGithubAgentEvents(delivery, deps);
    const again = await routeGithubAgentEvents(
      { ...delivery, receivedAt: '2026-11-25T12:05:00.000Z' },
      deps,
    );
    expect(publish).toHaveBeenCalledTimes(1);
    expect(again.events).toEqual([
      expect.objectContaining({ outcome: 'routed', published: 0 }),
    ]);
  });

  describe('no-subscriber fast path', () => {
    it('stops after one lookup and makes no GitHub read when nobody subscribed', async () => {
      const { deps, publish, listForKey, checkRuns } = await setup([
        subscription('other', { key: 'github:pr:jlapenna/homelab#8' }),
      ]);
      const result = await routeGithubAgentEvents(checkRun(), deps);
      expect(listForKey).toHaveBeenCalledTimes(1);
      expect(checkRuns).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(result.events).toEqual([
        { key: KEY, kind: 'checks-finished', outcome: 'no-subscriber' },
      ]);
    });

    it('makes no GitHub read for a subscriber that wants other kinds', async () => {
      const { deps, threadsResolved, publish } = await setup([
        subscription('a', { kinds: ['thread'] }),
      ]);
      const result = await routeGithubAgentEvents(threadResolved(), deps);
      expect(threadsResolved).not.toHaveBeenCalled();
      expect(result.events.map((e) => [e.kind, e.outcome])).toEqual([
        ['thread', 'routed'],
        ['threads-resolved', 'no-subscriber'],
      ]);
      expect(publish).toHaveBeenCalledTimes(1);
    });
  });

  describe('checks-finished', () => {
    it('routes once every check run on the head is complete', async () => {
      const { deps, publish, checkRuns } = await setup([subscription('a')], {
        checkRuns: async () => [
          { id: 11, status: 'completed', conclusion: 'success' },
          { id: 12, status: 'completed', conclusion: 'failure' },
        ],
      });
      await routeGithubAgentEvents(checkRun(), deps);
      expect(checkRuns).toHaveBeenCalledWith('jlapenna/homelab', SHA);
      expect(notices(publish)).toEqual([
        expect.objectContaining({
          id: `github.checks.${SHA}.12`,
          kind: 'checks-finished',
          detail: '1 failed',
          link: 'https://github.com/jlapenna/homelab/pull/7/checks',
        }),
      ]);
      expect(notices(publish)[0]).not.toHaveProperty('actor');
    });

    it('coalesces completions that see the same finished set into one notice', async () => {
      const { deps, publish } = await setup([subscription('a')], {
        checkRuns: async () => [
          { id: 11, status: 'completed', conclusion: 'success' },
        ],
      });
      await routeGithubAgentEvents(checkRun(), deps);
      await routeGithubAgentEvents(
        checkRun('72d3162e-cc78-11e3-81ab-4c9367dc0959'),
        deps,
      );
      expect(publish).toHaveBeenCalledTimes(1);
    });

    it('routes nothing while a check is still running, or when the read fails', async () => {
      const running = await setup([subscription('a')], {
        checkRuns: async () => [
          { id: 11, status: 'completed', conclusion: 'success' },
          { id: 12, status: 'queued', conclusion: null },
        ],
      });
      expect(
        (await routeGithubAgentEvents(checkRun(), running.deps)).events,
      ).toEqual([
        { key: KEY, kind: 'checks-finished', outcome: 'not-derived' },
      ]);
      expect(running.publish).not.toHaveBeenCalled();

      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const failing = await setup([subscription('a')], {
        checkRuns: async () => {
          throw new Error('GitHub unavailable');
        },
      });
      expect(
        (await routeGithubAgentEvents(checkRun(), failing.deps)).events,
      ).toEqual([
        { key: KEY, kind: 'checks-finished', outcome: 'not-derived' },
      ]);
    });
  });

  it('routes threads-resolved only when no unresolved thread remains', async () => {
    const open = await setup([subscription('a')], {
      threadsResolved: async () => false,
    });
    await routeGithubAgentEvents(threadResolved(), open.deps);
    expect(notices(open.publish).map((e) => e.kind)).toEqual(['thread']);

    const resolved = await setup([subscription('a')]);
    await routeGithubAgentEvents(threadResolved(), resolved.deps);
    expect(notices(resolved.publish).map((e) => e.kind)).toEqual([
      'thread',
      'threads-resolved',
    ]);
    expect(resolved.threadsResolved).toHaveBeenCalledWith(
      'jlapenna/homelab',
      7,
    );
  });

  it('throws after a failed publish so the delivery is retried', async () => {
    const { deps, publish } = await setup([subscription('a')]);
    publish.mockRejectedValueOnce(new Error('pubsub down'));
    await expect(
      routeGithubAgentEvents(
        {
          event: 'pull_request_review',
          deliveryId: DELIVERY,
          receivedAt: '2026-11-25T12:00:00.000Z',
          payload: review('jlapenna', 'OWNER'),
        },
        deps,
      ),
    ).rejects.toThrow(AggregateError);
  });
});

describe('queueGithubAgentEvents', () => {
  const envelope = {
    rawBody: Buffer.from('{}'),
    deliveryId: DELIVERY,
    eventName: 'pull_request_review',
    signature: 'sha256=x',
  };

  it('enqueues a delivery that stands for an event', async () => {
    const enqueue = vi.fn(async () => ({ outcome: 'enqueued' as const }));
    await expect(
      queueGithubAgentEvents(envelope, review('jlapenna', 'OWNER'), enqueue),
    ).resolves.toBe('enqueued');
    expect(enqueue).toHaveBeenCalledWith(envelope);
  });

  it('enqueues nothing for an untrusted actor or an unmapped delivery', async () => {
    const enqueue = vi.fn();
    await expect(
      queueGithubAgentEvents(envelope, review('drive-by', 'NONE'), enqueue),
    ).resolves.toBe('no-event');
    await expect(
      queueGithubAgentEvents(
        { ...envelope, eventName: 'pull_request' },
        { action: 'labeled' },
        enqueue,
      ),
    ).resolves.toBe('no-event');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never throws: a failed enqueue is logged', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const enqueue = vi.fn(async () => {
      throw new Error('queue down');
    });
    await expect(
      queueGithubAgentEvents(envelope, review('jlapenna', 'OWNER'), enqueue),
    ).resolves.toBe('failed');
  });
});
