import type { AgentEventSubscriptionView } from '@agent-lcars/work';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OpenPreviewListener } from './github-stream-process';
import type { GithubPreviewRead } from './github-stream-source';
import { GithubStreams } from './github-streams';
import { DeliveryMetrics } from './metrics';
import type { SubscriptionForwarder } from './subscribe-forwarder';

const now = Date.parse('2026-11-26T00:00:00.000Z');
const subscriptions = new Set<GithubStreams>();
afterEach(async () => {
  await Promise.all([...subscriptions].map((s) => s.stop()));
  subscriptions.clear();
  vi.useRealTimers();
});
function setup({
  attachFailure = false,
  readFailure = false,
  existing = false,
} = {}) {
  const rows = new Map<string, AgentEventSubscriptionView>();
  const row = (sessionId: string): AgentEventSubscriptionView => ({
    id: sessionId,
    key: 'github:pr:acme/widgets#8',
    source: 'github:pr',
    githubStream: true,
    kinds: ['merged'],
    until: 'merged',
    target: { type: 'session', sessionId, host: 'pike' },
    createdAt: new Date(now).toISOString(),
  });
  if (existing) rows.set('s1', row('s1'));
  const base: SubscriptionForwarder = {
    subscribe: vi.fn<SubscriptionForwarder['subscribe']>(
      async (sessionId, _request, native) => {
        if (!native)
          return {
            ok: false,
            error: 'forbidden',
            message:
              'GitHub event delivery is not available: the App source does not watch this repository',
            retryable: false,
          };
        rows.set(sessionId, rows.get(sessionId) ?? row(sessionId));
        return { ok: true, value: rows.get(sessionId)! };
      },
    ),
    list: vi.fn<SubscriptionForwarder['list']>(async () => ({
      ok: true,
      value: [...rows.values()],
    })),
    unsubscribe: vi.fn<SubscriptionForwarder['unsubscribe']>(async (id) => {
      rows.delete(id);
      return { ok: true, value: { id } };
    }),
    reportSession: vi.fn<SubscriptionForwarder['reportSession']>(async () => ({
      ok: true,
      value: { eventId: 'ended', delivered: 0 },
    })),
    reportGithub: vi.fn<NonNullable<SubscriptionForwarder['reportGithub']>>(
      async () => ({
        ok: true,
        value: { eventId: 'event', delivered: 1 },
      }),
    ),
  };
  const handles: {
    attach: () => void;
    event: (e: unknown) => void;
    detach: () => void;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const open: OpenPreviewListener = vi.fn((_url, attach, event, detach) => {
    let close: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const stop = vi.fn(async () => {
      close();
    });
    handles.push({ attach, event, detach: () => detach?.(), stop });
    return {
      ready: attachFailure
        ? Promise.reject(new Error('offline'))
        : Promise.resolve().then(attach),
      closed,
      stop,
    };
  });
  const api = {
    get: vi.fn(async () => {
      if (readFailure) throw new Error('offline');
      return {
        number: 8,
        state: 'open',
        merged: false,
        merged_at: null,
        closed_at: null,
        updated_at: new Date(now).toISOString(),
        merged_by: null,
        user: { login: 'author' },
        author_association: 'NONE',
        mergeable: true,
        head: { sha: 'a'.repeat(40), repo: { full_name: 'fork/widgets' } },
        base: { repo: { full_name: 'acme/widgets' } },
      };
    }),
    pages: vi.fn<GithubPreviewRead['pages']>(async () => [[]]),
  };
  const metrics = new DeliveryMetrics();
  const cursors = new Map<string, string>();
  const checkpoints = {
    get: (key: string) => cursors.get(key),
    set: vi.fn((key: string, at: string) => {
      cursors.set(key, at);
    }),
  };
  const streams = new GithubStreams({
    forwarder: base,
    api,
    checkpoints,
    open,
    metrics,
    log: vi.fn(),
    now: () => now,
  });
  subscriptions.add(streams);
  const subscribe = (sessionId = 's1') =>
    streams.forwarder.subscribe(sessionId, {
      key: 'github:pr:acme/widgets#8',
      kinds: ['merged'],
      until: 'merged',
    });
  return {
    streams,
    base,
    open,
    handles,
    api,
    metrics,
    subscribe,
    rows,
    checkpoints,
  };
}

describe('host GitHub stream lifecycle', () => {
  it('confirms subscribe only after attach and authoritative state read', async () => {
    const t = setup();
    expect(await t.subscribe()).toMatchObject({
      ok: true,
      value: { githubStream: true },
    });
    expect(t.api.get).toHaveBeenCalled();
    expect(t.metrics.githubStreamsWanted).toBe(1);
    expect(t.metrics.githubStreamsOpen).toBe(1);
    expect(t.metrics.githubSnapshots).toBe(1);
  });
  it.each([{ attachFailure: true }, { readFailure: true }])(
    'removes newly registered waits on initial failure %j',
    async (options) => {
      const t = setup(options);
      expect(await t.subscribe()).toMatchObject({
        ok: false,
        error: 'unavailable',
      });
      expect(t.base.unsubscribe).toHaveBeenCalledWith('s1');
      expect(t.rows.size).toBe(0);
      expect(t.metrics.githubStreamsWanted).toBe(0);
      expect(t.handles[0].stop).toHaveBeenCalled();
    },
  );
  it('preserves pre-existing registrations on a failed reattach', async () => {
    const t = setup({ attachFailure: true, existing: true });
    expect(await t.subscribe()).toMatchObject({ ok: false });
    expect(t.base.unsubscribe).not.toHaveBeenCalled();
    expect(t.rows.size).toBe(1);
    expect(t.metrics.githubStreamsWanted).toBe(1);
  });
  it('shares one stream and closes it only after the final session unsubscribes', async () => {
    const t = setup();
    await t.subscribe();
    await t.subscribe('s2');
    expect(t.open).toHaveBeenCalledTimes(1);
    await t.streams.forwarder.unsubscribe('s1');
    expect(t.handles[0].stop).not.toHaveBeenCalled();
    await t.streams.forwarder.unsubscribe('s2');
    expect(t.handles[0].stop).toHaveBeenCalledTimes(1);
    expect(t.metrics.githubStreamsWanted).toBe(0);
  });
  it('rereads on every reconnect and ignores malformed notices', async () => {
    const t = setup();
    await t.subscribe();
    t.handles[0].detach();
    expect(t.metrics.githubStreamsOpen).toBe(0);
    t.handles[0].attach();
    await vi.waitFor(() => expect(t.api.get).toHaveBeenCalledTimes(2));
    expect(t.metrics.githubStreamsOpen).toBe(1);
    t.handles[0].event({
      type: 'com.github.pull_request.state.changed.v1',
      data: { api_url: 'https://evil.example/read' },
    });
    await Promise.resolve();
    expect(t.api.get).toHaveBeenCalledTimes(2);
  });
  it('does not confirm a new registration while its shared stream is detached', async () => {
    const t = setup();
    await t.subscribe();
    t.handles[0].detach();
    expect(await t.subscribe('s2')).toMatchObject({
      ok: false,
      error: 'unavailable',
    });
    expect(t.rows.has('s2')).toBe(false);
    expect(t.rows.has('s1')).toBe(true);
    expect(t.metrics.githubStreamsWanted).toBe(1);
  });
  it('refuses success if an attached shared stream detaches during the registration read', async () => {
    const t = setup();
    await t.subscribe();
    const original = await t.api.get.mock.results[0].value;
    let finish: (value: typeof original) => void;
    t.api.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = t.subscribe('s2');
    await vi.waitFor(() => expect(t.api.get).toHaveBeenCalledTimes(2));
    t.handles[0].detach();
    finish!(original);
    expect(await pending).toMatchObject({ ok: false, error: 'unavailable' });
    expect(t.rows.has('s1')).toBe(true);
    expect(t.rows.has('s2')).toBe(false);
  });
  it('covers the full allowed clock skew when checkpointing review catch-up', async () => {
    const t = setup({ existing: true });
    const prior = t.rows.get('s1')!;
    t.rows.set('s1', {
      ...prior,
      createdAt: new Date(now - 10 * 60_000).toISOString(),
      kinds: ['review', 'merged'],
    });
    await t.streams.restore();
    const since = t.checkpoints.get(prior.key)!;
    // Host clock is four minutes ahead of the review's GitHub timestamp.
    expect(Date.parse(since)).toBeLessThan(now - 4 * 60_000);
    t.api.pages.mockImplementation(async (path) =>
      path.includes('/reviews')
        ? [
            [
              {
                id: 42,
                user: { login: 'maintainer' },
                author_association: 'MEMBER',
                submitted_at: new Date(now - 4 * 60_000).toISOString(),
                state: 'APPROVED',
              },
            ],
          ]
        : [[]],
    );
    t.handles[0].attach();
    await vi.waitFor(() =>
      expect(t.base.reportGithub).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'review', actor: 'maintainer' }),
      ),
    );
  });
  it('restores only marked native sources after agent restart', async () => {
    const t = setup({ existing: true });
    await t.streams.restore();
    expect(t.open).toHaveBeenCalledTimes(1);
    expect(t.metrics.githubRestoreReady).toBe(1);
    await t.streams.forwarder.reportSession(
      's1',
      'ended',
      new Date(now).toISOString(),
    );
    expect(t.base.unsubscribe).toHaveBeenCalledWith('s1');
    expect(t.handles[0].stop).toHaveBeenCalled();
  });
});
