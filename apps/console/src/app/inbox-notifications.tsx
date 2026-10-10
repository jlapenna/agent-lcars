'use client';

import { Button, Group, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';

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

export function InboxNotifications({ principalId }: { principalId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Notifications off');
  const latest = useRef(principalId);
  const stopped = useRef(false);
  const epoch = useRef(0);
  const running = useRef(false);
  const baseline = useRef(true);
  const key = notificationStorageKey(principalId);
  const tag = `inbox:${encodeURIComponent(principalId)}`;
  useEffect(() => {
    latest.current = principalId;
  }, [principalId]);

  useEffect(() => {
    const controlEpoch = epoch;
    stopped.current = false;
    setBusy(false);
    baseline.current = true;
    ++epoch.current;
    const read = () => parseNotificationState(localStorage.getItem(key));
    const write = (state: ReturnType<typeof read>) =>
      localStorage.setItem(key, JSON.stringify(state));
    const observe = async () => {
      if (running.current || stopped.current) return;
      const generation = epoch.current;
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
        running.current = true;
        const fresh = await bounded(readInboxNotificationSnapshot());
        if (stopped.current || generation !== epoch.current) return;
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
            if (!lock || stopped.current || generation !== epoch.current)
              return;
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
            if (
              !registration?.active ||
              Notification.permission !== 'granted'
            ) {
              setStatus(
                'Notification worker unavailable — disable and enable to reconnect',
              );
              return;
            }
            if (stopped.current || generation !== epoch.current) return;
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
            if (!stopped.current && generation === epoch.current)
              setStatus(
                'Notification requested — browser or OS may suppress display',
              );
          },
        );
      } catch {
        if (!stopped.current && generation === epoch.current)
          setStatus('Notification delivery or preferences unavailable');
      } finally {
        running.current = false;
      }
    };
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
  }, [key, tag]);

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
      const fresh = await bounded(readInboxNotificationSnapshot());
      if (!current()) return;
      if (
        fresh.principalId !== principalId ||
        !notificationSnapshotFresh(fresh, Date.now())
      )
        throw new Error('Authorization or data unavailable');
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
      await navigator.locks.request(key, () => {
        if (!current()) return;
        const stored = parseNotificationState(localStorage.getItem(key));
        if (
          Object.keys(stored.sourceTimes).some(
            (key) =>
              fresh.sourceTimes[key as keyof typeof fresh.sourceTimes] <
              stored.sourceTimes[key as keyof typeof fresh.sourceTimes],
          )
        )
          throw new Error('Older activation snapshot');
        const state = {
          ...stored,
          enabled: true,
          active: fresh.decisions,
          pending: [],
          observedAt: fresh.observedAt,
          sourceTimes: fresh.sourceTimes,
        };
        localStorage.setItem(key, JSON.stringify(state));
      });
      if (!current()) return;
      baseline.current = false;
      setEnabled(true);
      setStatus('Watching for new human decisions');
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
      const notifications = await bounded(
        registration?.getNotifications({ tag }) ?? Promise.resolve([]),
      );
      for (const notification of notifications) notification.close();
    } catch {
      if (current())
        setStatus('Unsubscribe or notification cleanup unavailable');
    } finally {
      if (current()) setBusy(false);
    }
  }

  return (
    <Stack gap="xs" mb="md" data-testid="inbox-notifications">
      <Group>
        <Button
          variant="outline"
          size="compact-md"
          mih={44}
          disabled={busy}
          onClick={() => {
            void (enabled ? disable() : enable());
          }}
        >
          {enabled
            ? 'Disable Inbox notifications'
            : 'Enable Inbox notifications'}
        </Button>
        <Text size="xs" c="dimmed" role="status">
          {status}
        </Text>
      </Group>
      <Text size="xs" c="dimmed">
        This browser, all repositories. Keep an Inbox tab open. Previews contain
        no decision details. Closed-tab delivery is unavailable.
      </Text>
    </Stack>
  );
}
