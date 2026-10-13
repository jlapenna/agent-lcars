'use client';

import { Button, Text, VisuallyHidden } from '@mantine/core';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  advanceNotificationState,
  NOTIFICATION_RATE_MS,
  NOTIFICATION_SCOPE,
  NOTIFICATION_WORKER,
  notificationHref,
  notificationSnapshotFresh,
  notificationStorageKey,
  parseNotificationState,
} from '../lib/inbox-notifications';
import { readInboxNotificationSnapshot } from '../lib/inbox-notifications-client';

function supported() {
  return (
    window.isSecureContext &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'locks' in navigator
  );
}

const OFF_INBOX_STATUS =
  'Notifications on — delivered while an Inbox tab is open';

/** Bound waits for browser/server APIs. Notification attempts are durably
 * consumed before display, so ambiguous completion is never automatically
 * retried; subsequent attempts retain the persisted one-minute limit. */
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Notification operation timed out')),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface InboxNotificationsController {
  enabled: boolean;
  busy: boolean;
  status: string;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

/** Delivery state for one signed-in principal. The observer that reads the
 * decision snapshot and asks the worker to notify runs only while `watching`
 * (an Inbox page is open); the opt-in itself works from anywhere. */
function useInboxNotificationsController(
  principalId: string,
  watching: boolean,
): InboxNotificationsController {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Notifications off');
  const latest = useRef(principalId);
  const stopped = useRef(false);
  const epoch = useRef(0);
  const baseline = useRef(true);
  // Read through a ref: an Inbox page mounting or unmounting must not restart
  // the observer, which would bump the epoch and cancel an opt-in in flight.
  const watchingRef = useRef(watching);
  const observeRef = useRef<() => void>(undefined);
  const key = notificationStorageKey(principalId);
  const tag = `inbox:${encodeURIComponent(principalId)}`;
  useEffect(() => {
    latest.current = principalId;
  }, [principalId]);

  useEffect(() => {
    const controlEpoch = epoch;
    // A retired observer must not release the next account's in-flight guard.
    let running = false;
    stopped.current = false;
    setBusy(false);
    baseline.current = true;
    ++epoch.current;
    const read = () => parseNotificationState(localStorage.getItem(key));
    const write = (state: ReturnType<typeof read>) =>
      localStorage.setItem(key, JSON.stringify(state));
    const observe = async () => {
      if (running || stopped.current || latest.current !== principalId) return;
      if (!watchingRef.current) {
        // Away from the Inbox the preference is shown, never acted on. Corrupt
        // storage fails closed here too.
        try {
          const stored = read();
          setEnabled(stored.enabled);
          setStatus(stored.enabled ? OFF_INBOX_STATUS : 'Notifications off');
        } catch {
          setStatus('Notification delivery or preferences unavailable');
        }
        return;
      }
      const generation = epoch.current;
      // Leaving the Inbox ends delivery for an observation already in flight:
      // it may not write the ledger or ask the worker to notify afterwards.
      const current = () =>
        !stopped.current &&
        watchingRef.current &&
        generation === epoch.current &&
        latest.current === principalId;
      try {
        const stored = read();
        setEnabled(stored.enabled);
        if (!stored.enabled) {
          setStatus('Notifications off');
          return;
        }
        if (!supported() || Notification.permission !== 'granted') {
          setStatus(
            'Notifications unavailable — check browser permission and support',
          );
          return;
        }
        running = true;
        const fresh = await bounded(readInboxNotificationSnapshot());
        if (!current()) return;
        if (
          fresh.principalId !== latest.current ||
          !notificationSnapshotFresh(fresh, Date.now())
        ) {
          setStatus('Authorization or data unavailable — notifications paused');
          return;
        }
        await navigator.locks.request(
          key,
          { ifAvailable: true },
          async (lock) => {
            if (!lock || !current()) return;
            // Lock acquisition can outlive the authenticated snapshot. Pause
            // before resetting a baseline or changing the pending ledger.
            if (!notificationSnapshotFresh(fresh, Date.now())) {
              setStatus(
                'Authorization or data unavailable — notifications paused',
              );
              return;
            }
            let state = read();
            if (!state.enabled) return;
            if (baseline.current) {
              if (Date.now() - state.observedAt >= 60_000)
                state = { ...state, active: null, pending: [] };
              baseline.current = false;
            }
            state = advanceNotificationState(state, fresh, Date.now());
            write(state);
            if (state.pending.length === 0) {
              setStatus('Watching for new human decisions');
              return;
            }
            if (Date.now() - state.lastSentAt < NOTIFICATION_RATE_MS) {
              setStatus(
                'New decisions waiting for the one-minute notification limit',
              );
              return;
            }
            // Current native grants can change while cached GitHub timestamps
            // stay equal. History ordering never grants permission to display.
            const authorized = new Map(
              fresh.decisions.map((d) => [d.id, d.generation]),
            );
            const candidates = state.pending.filter(
              (d) => authorized.get(d.id) === d.generation,
            );
            if (candidates.length === 0) {
              setStatus('No currently authorized pending decisions');
              return;
            }
            const registration = await bounded(
              navigator.serviceWorker.getRegistration(NOTIFICATION_SCOPE),
            );
            if (!current()) return;
            if (
              !registration?.active ||
              Notification.permission !== 'granted'
            ) {
              setStatus(
                'Notification worker unavailable — disable and enable to reconnect',
              );
              return;
            }
            if (!notificationSnapshotFresh(fresh, Date.now())) {
              setStatus(
                'Authorization or data unavailable — notifications paused',
              );
              return;
            }
            // Record the request BEFORE handing it to the OS. An ambiguous
            // result cannot be retried as another notification by a second tab.
            const href = notificationHref(candidates);
            const delivered = new Set(candidates.map((d) => d.id));
            write({
              ...state,
              pending: state.pending.filter((d) => !delivered.has(d.id)),
              lastSentAt: Date.now(),
            });
            const options = {
              body: 'A new human decision is available. Open the Inbox to review.',
              tag,
              renotify: true,
              data: { href },
            };
            await bounded(
              registration.showNotification('Agent LCARS', options),
            );
            if (current())
              setStatus(
                'Notification requested — browser or OS may suppress display',
              );
          },
        );
      } catch {
        if (current())
          setStatus('Notification delivery or preferences unavailable');
      } finally {
        running = false;
      }
    };
    observeRef.current = () => void observe();
    void observe();
    const timer = setInterval(() => {
      void observe();
    }, 30_000);
    const changed = (event: StorageEvent) => {
      if (event.key === key) void observe();
    };
    window.addEventListener('storage', changed);
    return () => {
      stopped.current = true;
      ++controlEpoch.current;
      clearInterval(timer);
      window.removeEventListener('storage', changed);
    };
  }, [key, tag, principalId]);

  useEffect(() => {
    // Each return to the Inbox re-baselines, as a fresh mount used to: a
    // stale prior observation resumes quietly instead of replaying what
    // arrived while the Inbox was closed.
    if (watching && !watchingRef.current) baseline.current = true;
    watchingRef.current = watching;
    observeRef.current?.();
  }, [watching]);

  async function enable() {
    const identity = principalId;
    const generation = epoch.current;
    const current = () =>
      !stopped.current &&
      epoch.current === generation &&
      latest.current === identity;
    if (!supported()) {
      setStatus('Notifications unavailable in this browser');
      return;
    }
    setBusy(true);
    try {
      // Permission is requested only from this explicit user gesture.
      const permission = await Notification.requestPermission();
      if (!current()) return;
      if (permission !== 'granted') {
        setStatus(
          'Notifications not permitted — change browser settings to enable',
        );
        return;
      }
      // Opt-in is a browser preference, not a health check of every source.
      // A missing baseline pauses delivery; it must not discard consent.
      const fresh = await bounded(readInboxNotificationSnapshot()).catch(
        () => undefined,
      );
      if (!current()) return;
      if (fresh && fresh.principalId !== principalId)
        throw new Error('Account changed');
      const registration = await bounded(
        navigator.serviceWorker.register(NOTIFICATION_WORKER, {
          scope: NOTIFICATION_SCOPE,
        }),
      );
      if (!current()) return;
      if (!registration.active) {
        const worker = registration.installing ?? registration.waiting;
        if (!worker) throw new Error('Worker unavailable');
        await bounded(
          new Promise<void>((resolve, reject) => {
            const changed = () => {
              if (worker.state === 'activated') {
                worker.removeEventListener('statechange', changed);
                resolve();
              } else if (worker.state === 'redundant') {
                worker.removeEventListener('statechange', changed);
                reject(new Error('Worker unavailable'));
              }
            };
            worker.addEventListener('statechange', changed);
            changed();
          }),
        );
      }
      if (!current()) return;
      let baselineReady = false;
      await navigator.locks.request(key, () => {
        if (!current()) return;
        const stored = parseNotificationState(localStorage.getItem(key));
        baselineReady =
          fresh !== undefined &&
          notificationSnapshotFresh(fresh, Date.now()) &&
          !Object.keys(stored.sourceTimes).some(
            (key) =>
              fresh.sourceTimes[key as keyof typeof fresh.sourceTimes] <
              stored.sourceTimes[key as keyof typeof fresh.sourceTimes],
          );
        const state = {
          ...stored,
          enabled: true,
          // Never establish history from stale or degraded authorization.
          // The first healthy observation will be a quiet baseline instead.
          active: baselineReady && fresh ? fresh.decisions : null,
          pending: [],
          observedAt:
            baselineReady && fresh ? fresh.observedAt : stored.observedAt,
          sourceTimes:
            baselineReady && fresh ? fresh.sourceTimes : stored.sourceTimes,
        };
        localStorage.setItem(key, JSON.stringify(state));
      });
      if (!current()) return;
      baseline.current = !baselineReady;
      setEnabled(true);
      setStatus(
        !watchingRef.current
          ? OFF_INBOX_STATUS
          : baselineReady
            ? 'Watching for new human decisions'
            : 'Authorization or data unavailable — notifications paused',
      );
    } catch {
      if (current()) setStatus('Notification activation unavailable');
    } finally {
      if (current()) setBusy(false);
    }
  }

  async function disable() {
    const generation = ++epoch.current;
    const identity = principalId;
    const current = () =>
      !stopped.current &&
      epoch.current === generation &&
      latest.current === identity;
    setBusy(true);
    try {
      // Same lock linearizes unsubscribe with an in-flight display request.
      const unsubscribe = () => {
        if (!current()) return;
        const state = parseNotificationState(localStorage.getItem(key));
        localStorage.setItem(
          key,
          JSON.stringify({
            ...state,
            enabled: false,
            active: null,
            pending: [],
          }),
        );
      };
      if (navigator.locks) await navigator.locks.request(key, unsubscribe);
      else unsubscribe();
      if (!current()) return;
      setEnabled(false);
      setStatus('Notifications off');
      const registration = await bounded(
        navigator.serviceWorker.getRegistration(NOTIFICATION_SCOPE),
      );
      if (!current()) return;
      const notifications = await bounded(
        registration?.getNotifications({ tag }) ?? Promise.resolve([]),
      );
      if (!current()) return;
      for (const notification of notifications) notification.close();
    } catch {
      if (current())
        setStatus('Unsubscribe or notification cleanup unavailable');
    } finally {
      if (current()) setBusy(false);
    }
  }

  return { enabled, busy, status, enable, disable };
}

const InboxNotificationsContext = createContext<{
  controller: InboxNotificationsController;
  watch: () => () => void;
} | null>(null);

/**
 * Owns Inbox notification delivery for the signed-in maintainer. It sits at
 * the root so the preference can be changed from the console menu on any
 * page, while delivery itself stays scoped to an open Inbox tab: the Inbox
 * mounts `InboxNotificationsWatch`, and only then does the observer run.
 */
export function InboxNotificationsProvider({
  principalId,
  children,
}: {
  principalId: string;
  children: ReactNode;
}) {
  const [watchers, setWatchers] = useState(0);
  const controller = useInboxNotificationsController(principalId, watchers > 0);
  const watch = useCallback(() => {
    setWatchers((count) => count + 1);
    return () => setWatchers((count) => count - 1);
  }, []);
  const value = useMemo(() => ({ controller, watch }), [controller, watch]);
  return (
    <InboxNotificationsContext.Provider value={value}>
      {children}
    </InboxNotificationsContext.Provider>
  );
}

/** Marks this page as an open Inbox, which is when notifications deliver. */
export function InboxNotificationsWatch() {
  const watch = useContext(InboxNotificationsContext)?.watch;
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!watch) return;
    const release = watch();
    setActive(true);
    return () => {
      setActive(false);
      release();
    };
  }, [watch]);
  // A hidden marker, so a browser test can wait for the hydrated watch
  // rather than for streamed HTML that is visible before it is live.
  return (
    <span
      hidden
      data-testid="inbox-notifications-watch"
      data-active={active ? '' : undefined}
    />
  );
}

const SCOPE =
  'This browser, all repositories. Keep an Inbox tab open. Previews contain no decision details. Closed-tab delivery is unavailable.';

/** The opt-in control, shown under Preferences in the console menu. */
export function InboxNotificationsToggle() {
  const controller = useContext(InboxNotificationsContext)?.controller;
  if (!controller) return null;
  const { enabled, busy, status, enable, disable } = controller;
  return (
    <div
      className="queue-utility-menu__control inbox-notifications"
      data-testid="inbox-notifications"
    >
      <Button
        variant="subtle"
        size="compact-sm"
        className="inbox-notifications__toggle"
        disabled={busy}
        aria-label={
          enabled ? 'Disable Inbox notifications' : 'Enable Inbox notifications'
        }
        aria-describedby="inbox-notifications-scope"
        title={SCOPE}
        onClick={() => {
          void (enabled ? disable() : enable());
        }}
      >
        {enabled ? 'Disable notifications' : 'Enable notifications'}
      </Button>
      <Text size="xs" c="dimmed" role="status">
        {status}
      </Text>
      <VisuallyHidden id="inbox-notifications-scope">{SCOPE}</VisuallyHidden>
    </div>
  );
}
