import { MantineProvider } from '@mantine/core';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../lib/inbox-notifications-client', () => ({
  readInboxNotificationSnapshot: mocks.read,
}));
import {
  emptyNotificationState,
  type InboxNotificationSnapshot,
  notificationStorageKey,
  parseNotificationState,
} from '../lib/inbox-notifications';
import { InboxNotifications } from './inbox-notifications';

let now: number;
const first = { id: 'owner/repo#1', generation: 'needs-human' };
const second = { id: 'work:01ABC', generation: 'work:01ABC/r2' };
const sample = (
  decisions = [first],
  principalId = 'viewer',
): InboxNotificationSnapshot => ({
  principalId,
  observedAt: now,
  available: true,
  sourceTimes: { queue: now, activity: now, native: now },
  decisions,
});
const requestPermission = vi.fn();
const showNotification = vi.fn();
const close = vi.fn();
const registration = {
  active: {},
  showNotification,
  getNotifications: vi.fn(),
};
const register = vi.fn();
const getRegistration = vi.fn();
const storageKey = notificationStorageKey('viewer');
function tree(snapshot: InboxNotificationSnapshot) {
  return (
    <MantineProvider>
      <InboxNotifications principalId={snapshot.principalId} />
    </MantineProvider>
  );
}
async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}
async function tick() {
  await act(async () => {
    now += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
  });
}

// Browser-lock fixture serializes callbacks across component instances.
let locked = false;
const locks = {
  request: vi.fn(
    async (_key: string, options: unknown, cb?: (lock: unknown) => unknown) => {
      const callback = typeof options === 'function' ? options : cb;
      if (locked) return callback?.(null);
      locked = true;
      try {
        return await callback?.({});
      } finally {
        locked = false;
      }
    },
  ),
};

describe('opt-in Inbox notification delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    now = Date.parse('2026-10-10T01:00:00Z');
    vi.setSystemTime(now);
    localStorage.clear();
    locked = false;
    vi.clearAllMocks();
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: locks,
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register, getRegistration },
    });
    requestPermission.mockResolvedValue('granted');
    register.mockResolvedValue(registration);
    getRegistration.mockResolvedValue(registration);
    registration.getNotifications.mockResolvedValue([{ close }]);
    showNotification.mockResolvedValue(undefined);
    mocks.read.mockImplementation(async () => sample());
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('never requests permission or registers a worker until explicit opt-in, and starts quiet', async () => {
    render(tree(sample()));
    await tick();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    await click('Enable Inbox notifications');
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith('/inbox-notifications-sw.js', {
      scope: '/inbox/',
    });
    expect(showNotification).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Disable Inbox notifications' }),
    ).toBeVisible();
  });
  it('delivers generic text and a safe native deep link after fresh authorization', async () => {
    const view = render(tree(sample()));
    await click('Enable Inbox notifications');
    mocks.read.mockImplementation(async () => sample([first, second]));
    view.rerender(tree(sample([first, second])));
    await tick();
    expect(showNotification).toHaveBeenCalledOnce();
    expect(showNotification).toHaveBeenCalledWith(
      'Agent LCARS',
      expect.objectContaining({
        body: 'A new human decision is available. Open the Inbox to review.',
        data: { href: '/inbox?item=work%3A01ABC' },
      }),
    );
    await tick();
    expect(showNotification).toHaveBeenCalledOnce();
  });
  it('coalesces a burst until the persisted rate limit and revalidates still-actionable decisions', async () => {
    const view = render(tree(sample()));
    await click('Enable Inbox notifications');
    mocks.read.mockImplementation(async () => sample([first, second]));
    view.rerender(tree(sample([first, second])));
    await tick();
    const third = { id: 'owner/repo#3', generation: 'needs-human' };
    mocks.read.mockImplementation(async () => sample([first, second, third]));
    view.rerender(tree(sample([first, second, third])));
    await tick();
    expect(showNotification).toHaveBeenCalledOnce();
    await tick();
    expect(showNotification).toHaveBeenCalledTimes(2);
  });
  it('suppresses changed accounts, revoked grants and stale or degraded snapshots', async () => {
    const view = render(tree(sample()));
    await click('Enable Inbox notifications');
    mocks.read.mockImplementation(async () =>
      sample([first, second], 'other-viewer'),
    );
    view.rerender(tree(sample([first, second])));
    await tick();
    expect(showNotification).not.toHaveBeenCalled();
    mocks.read.mockImplementation(async () => sample([first]));
    await tick();
    expect(showNotification).not.toHaveBeenCalled();
    mocks.read.mockImplementation(async () => ({
      ...sample([first, second]),
      available: false,
    }));
    view.rerender(tree({ ...sample([first, second]), available: false }));
    await tick();
    expect(showNotification).not.toHaveBeenCalled();
  });
  it('unsubscribes, closes existing notices and can re-enable without replaying backlog', async () => {
    const view = render(tree(sample()));
    await click('Enable Inbox notifications');
    await click('Disable Inbox notifications');
    expect(close).toHaveBeenCalledOnce();
    mocks.read.mockImplementation(async () => sample([first, second]));
    view.rerender(tree(sample([first, second])));
    await tick();
    expect(showNotification).not.toHaveBeenCalled();
    await click('Enable Inbox notifications');
    const third = { id: 'owner/repo#3', generation: 'needs-human' };
    mocks.read.mockImplementation(async () => sample([first, second, third]));
    view.rerender(tree(sample([first, second, third])));
    await tick();
    expect(showNotification).toHaveBeenCalledOnce();
  });
  it('fails closed on corrupt storage and unsupported/denied browser permission', async () => {
    localStorage.setItem(storageKey, 'broken');
    render(tree(sample()));
    await tick();
    expect(screen.getByRole('status')).toHaveTextContent('unavailable');
    expect(showNotification).not.toHaveBeenCalled();
    cleanup();
    localStorage.clear();
    requestPermission.mockResolvedValue('denied');
    render(tree(sample()));
    await click('Enable Inbox notifications');
    expect(register).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
  });
  it('does not automatically retry an ambiguously completed OS request', async () => {
    const view = render(tree(sample()));
    await click('Enable Inbox notifications');
    showNotification.mockReturnValue(
      new Promise(() => {
        /* Deliberately unresolved OS request. */
      }),
    );
    mocks.read.mockImplementation(async () => sample([first, second]));
    view.rerender(tree(sample([first, second])));
    await tick();
    await tick();
    await tick();
    expect(showNotification).toHaveBeenCalledOnce();
    expect(
      JSON.parse(localStorage.getItem(storageKey) ?? '{}').pending,
    ).toEqual([]);
    await click('Disable Inbox notifications');
    expect(screen.getByRole('status')).toHaveTextContent('Notifications off');
  });
  it('discovers new decisions without an RSC rerender or manual refresh', async () => {
    render(tree(sample()));
    await click('Enable Inbox notifications');
    mocks.read.mockImplementation(async () => sample([first, second]));
    await tick();
    expect(showNotification).toHaveBeenCalledOnce();
  });
  it('retains the one-minute limit across unsubscribe and explicit re-enable', async () => {
    render(tree(sample()));
    await click('Enable Inbox notifications');
    mocks.read.mockImplementation(async () => sample([first, second]));
    await tick();
    expect(showNotification).toHaveBeenCalledOnce();
    await click('Disable Inbox notifications');
    await click('Enable Inbox notifications');
    const third = { id: 'owner/repo#3', generation: 'needs-human' };
    mocks.read.mockImplementation(async () => sample([first, second, third]));
    await tick();
    expect(showNotification).toHaveBeenCalledOnce();
    await tick();
    expect(showNotification).toHaveBeenCalledTimes(2);
  });
  it('never sends prior pending native work omitted by the current same-watermark authorization', async () => {
    const boundary = now;
    const sourceTimes = {
      queue: boundary,
      activity: boundary,
      native: boundary,
    };
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...emptyNotificationState(),
        enabled: true,
        active: [first, second],
        pending: [second],
        observedAt: boundary,
        sourceTimes,
      }),
    );
    mocks.read.mockImplementation(async () => ({
      ...sample([first]),
      observedAt: boundary,
      sourceTimes,
    }));
    render(tree(sample([first, second])));
    await tick();
    expect(showNotification).not.toHaveBeenCalled();
  });
  it('does not attribute an old pending enable to a newly signed-in account', async () => {
    let resolveRegistration: ((value: typeof registration) => void) | undefined;
    register.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRegistration = resolve;
        }),
    );
    const view = render(tree(sample()));
    await click('Enable Inbox notifications');
    view.rerender(tree(sample([first], 'other-viewer')));
    await act(async () => {
      resolveRegistration?.(registration);
    });
    expect(
      screen.getByRole('button', { name: 'Enable Inbox notifications' }),
    ).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Notifications off');
    expect(
      localStorage.getItem(notificationStorageKey('other-viewer')),
    ).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });
  it('deduplicates the same observed handoff across two Inbox tabs', async () => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ ...emptyNotificationState(), enabled: true }),
    );
    const a = render(tree(sample()));
    const b = render(tree(sample()));
    await tick();
    mocks.read.mockImplementation(async () => sample([first, second]));
    a.rerender(tree(sample([first, second])));
    b.rerender(tree(sample([first, second])));
    await tick();
    expect(showNotification).toHaveBeenCalledOnce();
  });
  it('pauses a pending display when its snapshot expires during worker lookup', async () => {
    const sampledAt = now - 59_000;
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...emptyNotificationState(),
        enabled: true,
        active: [first],
        pending: [first],
        observedAt: now,
        sourceTimes: {
          queue: sampledAt,
          activity: sampledAt,
          native: sampledAt,
        },
      }),
    );
    mocks.read.mockImplementation(async () => ({
      ...sample(),
      observedAt: sampledAt,
      sourceTimes: { queue: sampledAt, activity: sampledAt, native: sampledAt },
    }));
    getRegistration.mockImplementation(async () => {
      now += 2_000;
      vi.setSystemTime(now);
      return registration;
    });
    render(tree(sample()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getRegistration).toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
    expect(
      parseNotificationState(localStorage.getItem(storageKey)).lastSentAt,
    ).toBe(0);
    expect(screen.getByRole('status')).toHaveTextContent(
      'notifications paused',
    );
  });
  it('refuses a baseline that expires while registration completes', async () => {
    const sampledAt = now - 59_000;
    mocks.read.mockImplementation(async () => ({
      ...sample(),
      observedAt: sampledAt,
      sourceTimes: { queue: sampledAt, activity: sampledAt, native: sampledAt },
    }));
    register.mockImplementation(async () => {
      now += 2_000;
      vi.setSystemTime(now);
      return registration;
    });
    render(tree(sample()));
    await click('Enable Inbox notifications');
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      'activation unavailable',
    );
  });
});
