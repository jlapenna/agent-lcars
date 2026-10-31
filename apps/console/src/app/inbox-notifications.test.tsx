import { MantineProvider } from '@mantine/core';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), pushStatus: vi.fn() }));
vi.mock('./inbox-push-actions', () => ({ inboxPushStatus: mocks.pushStatus }));
vi.mock('./inbox-push-toggle', () => ({ InboxPushToggle: () => null }));
vi.mock('../lib/inbox-notifications-client', () => ({
  readInboxNotificationSnapshot: mocks.read,
}));
import {
  emptyNotificationState,
  type InboxNotificationSnapshot,
  notificationStorageKey,
  parseNotificationState,
} from '../lib/inbox-notifications';
import {
  InboxNotificationsProvider,
  InboxNotificationsToggle,
  InboxNotificationsWatch,
} from './inbox-notifications';

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
const openTabStatus = () =>
  screen.getByRole('status', { name: 'Open-tab notification status' });
function tree(snapshot: InboxNotificationSnapshot) {
  return (
    <MantineProvider>
      <InboxNotificationsProvider principalId={snapshot.principalId}>
        <InboxNotificationsWatch />
        <InboxNotificationsToggle />
      </InboxNotificationsProvider>
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
const modeLock = 'agent-lcars:notification-mode';
const locks = {
  request: vi.fn(
    async (_key: string, options: unknown, cb?: (lock: unknown) => unknown) => {
      const callback = typeof options === 'function' ? options : cb;
      if (_key === modeLock) return callback?.({});
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
    mocks.pushStatus.mockResolvedValue({ enabled: false });
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

  it('allows open-tab activation with an orphaned background endpoint', async () => {
    getRegistration.mockResolvedValue({
      ...registration,
      pushManager: {
        getSubscription: async () => ({
          endpoint: 'https://fcm.googleapis.com/orphan',
        }),
      },
    });
    render(tree(sample()));
    await click('Enable Inbox notifications');
    expect(mocks.pushStatus).toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Disable Inbox notifications' }),
    ).toBeTruthy();
  });

  it('never requests permission or registers a worker until explicit opt-in, and starts quiet', async () => {
    render(tree(sample()));
    await tick();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
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
  const withWatch = (watching: boolean, snapshot = sample()) => (
    <MantineProvider>
      <InboxNotificationsProvider principalId={snapshot.principalId}>
        {watching && <InboxNotificationsWatch />}
        <InboxNotificationsToggle />
      </InboxNotificationsProvider>
    </MantineProvider>
  );
  const third = { id: 'owner/repo#3', generation: 'review-requested' };

  it('re-baselines quietly when the maintainer returns to the Inbox', async () => {
    // The provider outlives client navigation, so leaving and returning must
    // not replay what arrived while the Inbox was closed.
    const view = render(withWatch(true));
    await click('Enable Inbox notifications');
    await tick();
    view.rerender(withWatch(false));
    mocks.read.mockImplementation(async () => sample([first, second]));
    await tick();
    await tick();
    await tick();
    view.rerender(withWatch(true));
    await tick();
    expect(showNotification).not.toHaveBeenCalled();
    // A decision arriving after the return still notifies.
    mocks.read.mockImplementation(async () => sample([first, second, third]));
    await tick();
    expect(showNotification).toHaveBeenCalledOnce();
  });

  it('says delivery waits for an Inbox after opting in from another page', async () => {
    render(withWatch(false));
    await click('Enable Inbox notifications');
    expect(
      screen.getByRole('button', { name: 'Disable Inbox notifications' }),
    ).toBeVisible();
    expect(openTabStatus()).toHaveTextContent(
      'Notifications on — delivered while an Inbox tab is open',
    );
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('shows the live delivery state on an opted-in Inbox only', async () => {
    const inboxStatus = () =>
      screen.queryByRole('status', { name: 'Inbox notification status' });
    const view = render(withWatch(true));
    await tick();
    expect(inboxStatus()).toBeNull();
    await click('Enable Inbox notifications');
    await tick();
    expect(inboxStatus()).toHaveTextContent(openTabStatus().textContent ?? '');
    view.rerender(withWatch(false));
    await tick();
    expect(inboxStatus()).toBeNull();
  });

  it('fails closed on corrupt storage away from the Inbox', async () => {
    localStorage.setItem(storageKey, 'broken');
    render(withWatch(false));
    await tick();
    expect(openTabStatus()).toHaveTextContent(
      'Notification delivery or preferences unavailable',
    );
  });

  it('delivers nothing from an observation still in flight when the Inbox closes', async () => {
    const view = render(withWatch(true));
    await click('Enable Inbox notifications');
    await tick();
    let release: () => void = () => undefined;
    mocks.read.mockImplementation(
      () =>
        new Promise<InboxNotificationSnapshot>((resolve) => {
          release = () => resolve(sample([first, second]));
        }),
    );
    await act(async () => {
      now += 30_000;
      await vi.advanceTimersByTimeAsync(30_000);
    });
    view.rerender(withWatch(false));
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(showNotification).not.toHaveBeenCalled();
    expect(
      parseNotificationState(localStorage.getItem(storageKey)).pending,
    ).toEqual([]);
  });

  it('completes an opt-in started from the menu before the Inbox watch mounts', async () => {
    // The console menu is usable while the Inbox body is still streaming;
    // the watch arriving mid-activation must not cancel the opt-in.
    let grant: (permission: string) => void = () => undefined;
    requestPermission.mockImplementation(
      () => new Promise<string>((resolve) => (grant = resolve)),
    );
    const menuOnly = (watching: boolean) => (
      <MantineProvider>
        <InboxNotificationsProvider principalId="viewer">
          {watching && <InboxNotificationsWatch />}
          <InboxNotificationsToggle />
        </InboxNotificationsProvider>
      </MantineProvider>
    );
    const view = render(menuOnly(false));
    expect(openTabStatus()).toHaveTextContent('Notifications off');
    await click('Enable Inbox notifications');
    view.rerender(menuOnly(true));
    await act(async () => {
      grant('granted');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(register).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('button', { name: 'Disable Inbox notifications' }),
    ).toBeVisible();
    expect(openTabStatus()).toHaveTextContent(
      'Watching for new human decisions',
    );
  });
  it.each(['failed read', 'degraded data', 'stale data'])(
    'retains opt-in across remounts after %s and quietly recovers',
    async (failure) => {
      if (failure === 'failed read')
        mocks.read.mockRejectedValue(new Error('Source unavailable'));
      else
        mocks.read.mockResolvedValue({
          ...sample(),
          available: failure !== 'degraded data',
          observedAt: failure === 'stale data' ? now - 60_000 : now,
        });
      const view = render(tree(sample()));
      await click('Enable Inbox notifications');
      expect(openTabStatus()).toHaveTextContent('notifications paused');
      expect(
        screen.getByRole('button', { name: 'Disable Inbox notifications' }),
      ).toBeEnabled();
      view.unmount();
      render(tree(sample()));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        screen.getByRole('button', { name: 'Disable Inbox notifications' }),
      ).toBeEnabled();
      expect(showNotification).not.toHaveBeenCalled();
      mocks.read.mockImplementation(async () => sample([first, second]));
      await tick();
      expect(openTabStatus()).toHaveTextContent(
        'Watching for new human decisions',
      );
      expect(showNotification).not.toHaveBeenCalled();
      const third = { id: 'owner/repo#3', generation: 'needs-human' };
      mocks.read.mockImplementation(async () => sample([first, second, third]));
      await tick();
      expect(showNotification).toHaveBeenCalledOnce();
      await click('Disable Inbox notifications');
      expect(
        parseNotificationState(localStorage.getItem(storageKey)).enabled,
      ).toBe(false);
    },
  );
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
    expect(openTabStatus()).toHaveTextContent('unavailable');
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
    expect(openTabStatus()).toHaveTextContent('Notifications off');
  });
  it('discovers new decisions without an RSC rerender or manual refresh', async () => {
    render(tree(sample()));
    await click('Enable Inbox notifications');
    await tick();
    await tick();
    await tick();
    expect(showNotification).not.toHaveBeenCalled();
    mocks.read.mockImplementation(async () => sample([first, second]));
    await tick();
    expect(showNotification).toHaveBeenCalledOnce();
  });
  it('discovers an observed reopening without rerendering unchanged props', async () => {
    render(tree(sample()));
    await click('Enable Inbox notifications');
    mocks.read.mockImplementation(async () => sample([]));
    await tick();
    expect(showNotification).not.toHaveBeenCalled();
    mocks.read.mockImplementation(async () => sample());
    await tick();
    expect(showNotification).toHaveBeenCalledOnce();
    expect(showNotification).toHaveBeenCalledWith(
      'Agent LCARS',
      expect.objectContaining({
        data: { href: '/inbox?item=owner%2Frepo%231' },
      }),
    );
    await tick();
    await tick();
    expect(showNotification).toHaveBeenCalledOnce();
  });
  it('stops source reads when permission is revoked or notifications are disabled', async () => {
    render(tree(sample()));
    await click('Enable Inbox notifications');
    mocks.read.mockClear();
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission });
    await tick();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(openTabStatus()).toHaveTextContent('check browser permission');
    await click('Disable Inbox notifications');
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
    await tick();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
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
  it.each([0, -1_000])(
    'never sends omitted native work with watermark offset %i',
    async (offset) => {
      const sourceTimes = { queue: now, activity: now, native: now };
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          ...emptyNotificationState(),
          enabled: true,
          active: [first, second],
          pending: [second],
          observedAt: now,
          sourceTimes,
        }),
      );
      mocks.read.mockImplementation(async () => ({
        ...sample([first]),
        sourceTimes: {
          queue: sourceTimes.queue + offset,
          activity: sourceTimes.activity + offset,
          native: sourceTimes.native + offset,
        },
      }));
      render(tree(sample()));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(showNotification).not.toHaveBeenCalled();
      expect(getRegistration).not.toHaveBeenCalled();
      expect(
        parseNotificationState(localStorage.getItem(storageKey)),
      ).toMatchObject({
        active: [first, second],
        pending: [second],
        sourceTimes,
        lastSentAt: 0,
      });
    },
  );
  it.each([0, -1_000])(
    'sends only currently authorized pending generations with watermark offset %i',
    async (offset) => {
      const sourceTimes = { queue: now, activity: now, native: now };
      const replacement = { ...second, generation: 'work:01ABC/r3' };
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          ...emptyNotificationState(),
          enabled: true,
          active: [first, second],
          pending: [second, first],
          observedAt: now,
          sourceTimes,
        }),
      );
      // An eligible replacement generation cannot authorize its predecessor.
      // Equal/older source clocks retain history independently of permission.
      mocks.read.mockImplementation(async () => ({
        ...sample([first, replacement]),
        sourceTimes: {
          queue: sourceTimes.queue + offset,
          activity: sourceTimes.activity + offset,
          native: sourceTimes.native + offset,
        },
      }));
      render(tree(sample()));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(showNotification).toHaveBeenCalledExactlyOnceWith(
        'Agent LCARS',
        expect.objectContaining({
          data: { href: '/inbox?item=owner%2Frepo%231' },
        }),
      );
      expect(
        parseNotificationState(localStorage.getItem(storageKey)),
      ).toMatchObject({
        active: [first, second],
        pending: [second],
        sourceTimes,
        lastSentAt: now,
      });
    },
  );
  it.each([
    'account mismatch',
    'unavailable source',
    'stale observation',
    'stale queue',
    'stale activity',
    'stale native',
    'denied permission',
  ])('pauses retained pending work on %s', async (failure) => {
    const sourceTimes = { queue: now, activity: now, native: now };
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...emptyNotificationState(),
        enabled: true,
        active: [second],
        pending: [second],
        observedAt: now,
        sourceTimes,
      }),
    );
    const fresh = sample([second]);
    if (failure === 'account mismatch') fresh.principalId = 'other-viewer';
    if (failure === 'unavailable source') fresh.available = false;
    if (failure === 'stale observation') fresh.observedAt -= 60_000;
    for (const source of ['queue', 'activity', 'native'] as const) {
      if (failure === `stale ${source}`) fresh.sourceTimes[source] -= 60_000;
    }
    if (failure === 'denied permission')
      vi.stubGlobal('Notification', {
        permission: 'denied',
        requestPermission,
      });
    mocks.read.mockResolvedValue(fresh);
    render(tree(sample()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(showNotification).not.toHaveBeenCalled();
    expect(getRegistration).not.toHaveBeenCalled();
    expect(
      parseNotificationState(localStorage.getItem(storageKey)),
    ).toMatchObject({
      pending: [second],
      lastSentAt: 0,
    });
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
    expect(openTabStatus()).toHaveTextContent('Notifications off');
    expect(
      localStorage.getItem(notificationStorageKey('other-viewer')),
    ).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });
  it.each(['permission', 'snapshot', 'activation', 'lock'] as const)(
    'abandons pending %s on an account change, even after returning to that account',
    async (stage) => {
      let release: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (stage === 'permission')
        requestPermission.mockImplementation(async () => {
          await pending;
          return 'granted';
        });
      if (stage === 'snapshot')
        mocks.read.mockImplementation(async () => {
          await pending;
          return sample();
        });
      if (stage === 'activation') {
        const worker = new EventTarget();
        Object.assign(worker, { state: 'installing' });
        register.mockResolvedValue({ active: null, installing: worker });
        release = () => {
          Object.assign(worker, { state: 'activated' });
          worker.dispatchEvent(new Event('statechange'));
        };
      }
      if (stage === 'lock')
        locks.request.mockImplementationOnce(async (_key, options) => {
          await pending;
          return typeof options === 'function' ? options({}) : undefined;
        });
      const view = render(tree(sample()));
      await click('Enable Inbox notifications');
      view.rerender(tree(sample([first], 'other-viewer')));
      expect(
        screen.getByRole('button', { name: 'Enable Inbox notifications' }),
      ).toBeEnabled();
      view.rerender(tree(sample()));
      await act(async () => {
        release?.();
      });
      expect(
        screen.getByRole('button', { name: 'Enable Inbox notifications' }),
      ).toBeEnabled();
      expect(openTabStatus()).toHaveTextContent('Notifications off');
      expect(localStorage.getItem(storageKey)).toBeNull();
      expect(
        localStorage.getItem(notificationStorageKey('other-viewer')),
      ).toBeNull();
      expect(showNotification).not.toHaveBeenCalled();
    },
  );
  it('abandons pending registration on unmount without persisting consent', async () => {
    let release: ((value: typeof registration) => void) | undefined;
    register.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const view = render(tree(sample()));
    await click('Enable Inbox notifications');
    view.unmount();
    await act(async () => {
      release?.(registration);
    });
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(showNotification).not.toHaveBeenCalled();
  });
  it('does not publish an old observer worker failure into the next account', async () => {
    let release: ((value: undefined) => void) | undefined;
    const view = render(tree(sample()));
    await click('Enable Inbox notifications');
    mocks.read.mockImplementation(async () => sample([first, second]));
    getRegistration.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await tick();
    view.rerender(tree(sample([first], 'other-viewer')));
    await act(async () => {
      release?.(undefined);
    });
    expect(openTabStatus()).toHaveTextContent('Notifications off');
    expect(
      screen.getByRole('button', { name: 'Enable Inbox notifications' }),
    ).toBeEnabled();
    expect(showNotification).not.toHaveBeenCalled();
    expect(
      localStorage.getItem(notificationStorageKey('other-viewer')),
    ).toBeNull();
  });
  it('starts observing the next opted-in account while the old source read is pending', async () => {
    let release: ((value: InboxNotificationSnapshot) => void) | undefined;
    const view = render(tree(sample()));
    await click('Enable Inbox notifications');
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await tick();
    const otherKey = notificationStorageKey('other-viewer');
    localStorage.setItem(
      otherKey,
      JSON.stringify({ ...emptyNotificationState(), enabled: true }),
    );
    mocks.read.mockImplementation(async () => sample([first], 'other-viewer'));
    await act(async () => {
      view.rerender(tree(sample([first], 'other-viewer')));
    });
    expect(openTabStatus()).toHaveTextContent(
      'Watching for new human decisions',
    );
    expect(
      parseNotificationState(localStorage.getItem(otherKey)).active,
    ).toEqual([first]);
    await act(async () => {
      release?.(sample());
    });
    expect(openTabStatus()).toHaveTextContent(
      'Watching for new human decisions',
    );
    expect(showNotification).not.toHaveBeenCalled();
  });
  it.each(['worker lookup', 'notification lookup'] as const)(
    'stops unsubscribe cleanup after an account change during %s',
    async (stage) => {
      let release: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const view = render(tree(sample()));
      await click('Enable Inbox notifications');
      if (stage === 'worker lookup')
        getRegistration.mockImplementation(async () => {
          await pending;
          return registration;
        });
      else
        registration.getNotifications.mockImplementation(async () => {
          await pending;
          return [{ close }];
        });
      await click('Disable Inbox notifications');
      view.rerender(tree(sample([first], 'other-viewer')));
      await act(async () => {
        release?.();
      });
      expect(close).not.toHaveBeenCalled();
      expect(registration.getNotifications).toHaveBeenCalledTimes(
        stage === 'worker lookup' ? 0 : 1,
      );
      expect(openTabStatus()).toHaveTextContent('Notifications off');
      expect(
        screen.getByRole('button', { name: 'Enable Inbox notifications' }),
      ).toBeEnabled();
      expect(
        parseNotificationState(localStorage.getItem(storageKey)).enabled,
      ).toBe(false);
      expect(
        localStorage.getItem(notificationStorageKey('other-viewer')),
      ).toBeNull();
    },
  );
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
    expect(openTabStatus()).toHaveTextContent('notifications paused');
  });
  it('preserves pending history when a snapshot expires while acquiring the observation lock', async () => {
    const sampledAt = now - 59_000;
    const stored = {
      ...emptyNotificationState(),
      enabled: true,
      active: [first],
      pending: [first],
      observedAt: sampledAt,
      lastSentAt: sampledAt,
      sourceTimes: { queue: sampledAt, activity: sampledAt, native: sampledAt },
    };
    localStorage.setItem(storageKey, JSON.stringify(stored));
    mocks.read.mockResolvedValue({
      ...sample(),
      observedAt: sampledAt,
      sourceTimes: stored.sourceTimes,
    });
    locks.request.mockImplementationOnce(async (_key, _options, callback) => {
      now += 2_000;
      vi.setSystemTime(now);
      return callback?.({});
    });
    render(tree(sample()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(parseNotificationState(localStorage.getItem(storageKey))).toEqual(
      stored,
    );
    expect(getRegistration).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
    expect(openTabStatus()).toHaveTextContent('notifications paused');

    // A valid observation establishes the quiet baseline; later arrivals
    // still deliver using the preserved rate accounting.
    mocks.read.mockImplementation(async () => sample());
    await tick();
    expect(showNotification).not.toHaveBeenCalled();
    mocks.read.mockImplementation(async () => sample([first, second]));
    await tick();
    expect(showNotification).toHaveBeenCalledExactlyOnceWith(
      'Agent LCARS',
      expect.objectContaining({ data: { href: '/inbox?item=work%3A01ABC' } }),
    );
  });
  it('retains opt-in without a baseline that expires while acquiring the activation lock', async () => {
    const sampledAt = now - 59_000;
    mocks.read.mockResolvedValue({
      ...sample(),
      observedAt: sampledAt,
      sourceTimes: { queue: sampledAt, activity: sampledAt, native: sampledAt },
    });
    locks.request.mockImplementationOnce(async (_key, options) => {
      now += 2_000;
      vi.setSystemTime(now);
      if (typeof options === 'function') return options({});
    });
    render(tree(sample()));
    await click('Enable Inbox notifications');
    expect(
      parseNotificationState(localStorage.getItem(storageKey)),
    ).toMatchObject({
      enabled: true,
      active: null,
      pending: [],
    });
    expect(openTabStatus()).toHaveTextContent('notifications paused');
    expect(
      screen.getByRole('button', { name: 'Disable Inbox notifications' }),
    ).toBeEnabled();
  });
  it('retains opt-in without a baseline that expires while registration completes', async () => {
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
    expect(
      parseNotificationState(localStorage.getItem(storageKey)),
    ).toMatchObject({
      enabled: true,
      active: null,
      pending: [],
    });
    expect(openTabStatus()).toHaveTextContent('notifications paused');
  });
});
