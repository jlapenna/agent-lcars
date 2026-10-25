import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

import type { AppRouterActionQueue } from 'next/dist/client/components/app-router-instance';
import type {
  AppRouterState,
  ServerActionAction,
} from 'next/dist/client/components/router-reducer/router-reducer-types';
import * as routerReducerTypes from 'next/dist/client/components/router-reducer/router-reducer-types';
import { isThenable } from 'next/dist/shared/lib/is-thenable';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  queue: vi.fn(),
  activity: vi.fn(),
  sessions: vi.fn(),
  context: vi.fn(),
  native: vi.fn(),
}));
vi.mock('./decision-snooze-store', () => ({
  getDecisionSnoozeStore: () => ({ read: async () => ({}) }),
}));
vi.mock('../auth', () => ({ auth: mocks.auth }));
vi.mock('./dashboard-data', () => ({
  getCachedQueueItems: mocks.queue,
  getCachedAgentActivity: mocks.activity,
}));
vi.mock('./runner-sessions', () => ({
  getRunnerSessionsByRunId: mocks.sessions,
}));
vi.mock('../app/work/context', () => ({ context: mocks.context }));
vi.mock('./native-inbox', () => ({ getNativeInboxCards: mocks.native }));

import { GET } from '../app/api/inbox-notifications/route';
import { readInboxNotificationSnapshot } from './inbox-notifications-client';
import { loadInboxNotificationSnapshot } from './inbox-notifications-data';

/** Execute the installed framework's queue verbatim, not a copied queue model.
 * Only unused rendering/navigation imports are isolated. The reducer boundary
 * invokes the owning loader or a reply witness rather than real mutations. */
function installedActionQueue(): AppRouterActionQueue {
  const require = createRequire(import.meta.url);
  const filename =
    require.resolve('next/dist/client/components/app-router-instance');
  const exports = {};
  runInNewContext(readFileSync(filename, 'utf8'), {
    exports,
    module: { exports },
    process,
    require: (id: string) => {
      if (id === 'react') return React;
      if (id === './router-reducer/router-reducer-types')
        return routerReducerTypes;
      if (id === '../../shared/lib/is-thenable') return { isThenable };
      return {};
    },
  });
  return (
    exports as {
      createMutableActionQueue: (state: AppRouterState) => AppRouterActionQueue;
    }
  ).createMutableActionQueue({} as AppRouterState);
}

function dispatch(queue: AppRouterActionQueue, actionId: string) {
  queue.dispatch(
    { type: 'server-action', actionId } as ServerActionAction,
    (state) => {
      // Observe rejection of React's deferred state even when a control fails.
      void Promise.resolve(state).catch(() => undefined);
    },
  );
}

describe('optional notification transport isolation from Work replies (#2319)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    mocks.auth.mockResolvedValue({ user: { id: 'viewer', isAdmin: true } });
    mocks.queue.mockResolvedValue({
      data: { items: [] },
      fetchedAt: new Date().toISOString(),
    });
    mocks.activity.mockResolvedValue({
      data: { recentRuns: [], liveRuns: [], warnings: [] },
      fetchedAt: new Date().toISOString(),
    });
    mocks.context.mockResolvedValue({ runtime: { store: {} }, principal: {} });
    mocks.native.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('negative control: timing out a queued loader still blocks the later reply', async () => {
    let release!: (value: unknown) => void;
    mocks.sessions.mockReturnValue(new Promise((done) => (release = done)));
    const queue = installedActionQueue();
    const reply = vi.fn();
    let notification!: ReturnType<typeof loadInboxNotificationSnapshot>;
    queue.action = async (state, action) => {
      if (
        action.type === 'server-action' &&
        action.actionId === 'notification'
      ) {
        notification = loadInboxNotificationSnapshot();
        await notification;
      } else reply();
      return state;
    };
    dispatch(queue, 'notification');
    // The old UI's observation deadline does not cancel its Server Action.
    const observed = Promise.race([
      notification,
      new Promise((done) => setTimeout(() => done('unavailable'), 5_000)),
    ]);
    dispatch(queue, 'reply');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await observed).toBe('unavailable');
    expect(mocks.sessions).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    release({ sessionsByRunId: new Map(), warnings: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(reply).toHaveBeenCalledOnce();
    expect(queue.pending).toBeNull();
  });

  it('a hung owning GET/loader cannot occupy the installed Work action queue', async () => {
    let release!: (value: unknown) => void;
    mocks.sessions.mockReturnValue(new Promise((done) => (release = done)));
    let response!: Awaited<ReturnType<typeof GET>>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        response = await GET();
        return response;
      }),
    );
    const optional = readInboxNotificationSnapshot().catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.sessions).toHaveBeenCalledOnce();
    const queue = installedActionQueue();
    const reply = vi.fn();
    queue.action = (state) => {
      reply();
      return state;
    };
    dispatch(queue, 'reply');
    expect(reply).toHaveBeenCalledOnce();
    expect(queue.pending).toBeNull();
    // This in-process bridge deliberately ignores abort, exercising the
    // independent server deadline. Real fetch abort is covered by client tests.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await optional).toEqual(
      new Error('Notification source unavailable'),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      error: 'Notification source unavailable',
    });
    release({ sessionsByRunId: new Map(), warnings: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(reply).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('auth refusal through the owning route starts no optional data reads', async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Notification source unavailable',
    });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    for (const read of [
      mocks.queue,
      mocks.activity,
      mocks.sessions,
      mocks.context,
      mocks.native,
    ])
      expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
