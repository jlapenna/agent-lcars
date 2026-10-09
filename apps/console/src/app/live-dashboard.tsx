'use client';

import { Text } from '@mantine/core';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';

import {
  DASHBOARD_EVENT,
  DASHBOARD_REFRESH_INTERVAL_MS,
  DASHBOARD_STALE_MS,
  DASHBOARD_STREAM_URL,
  type DashboardSignal,
} from '../lib/dashboard-stream-contract';
import { refreshDashboard } from './refresh-action';

/** Refresh merges RSC props into the existing tree: URL scope/selection,
 * drafts, focus and client state survive. Only one stream is mounted per
 * route, outside the data Suspense boundary (never in both utility variants).
 */
export function LiveDashboard() {
  const pathname = usePathname();
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [state, setState] = useState('Connecting — data may be stale');
  const [pending, startTransition] = useTransition();
  const [revision, setRevision] = useState(0);
  const applied = useRef(0);
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (pending || revision === applied.current) return;
    const timer = setTimeout(
      () => {
        applied.current = revision;
        lastRefresh.current = Date.now();
        startTransition(async () => {
          try {
            // updateTag expires synchronously; revalidatePath returns the new
            // RSC tree in this same action without a second navigation/fetch.
            await refreshDashboard(pathname);
            setRefreshFailed(false);
          } catch {
            setRefreshFailed(true);
          }
        });
      },
      Math.max(
        0,
        DASHBOARD_REFRESH_INTERVAL_MS - (Date.now() - lastRefresh.current),
      ),
    );
    return () => clearTimeout(timer);
  }, [pending, revision, pathname]);
  useEffect(() => {
    let disposed = false;
    let source: EventSource | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let stale: ReturnType<typeof setTimeout> | undefined;
    let retry = 1_000;
    let openedAt = 0;
    const retryConnection = (label: string) => {
      source?.close();
      clearTimeout(stale);
      if (disposed || reconnect !== undefined) return;
      setState(label);
      reconnect = setTimeout(() => {
        reconnect = undefined;
        connect();
      }, retry);
      retry = Math.min(retry * 2, 30_000);
    };
    const connect = () => {
      if (disposed) return;
      const next = new EventSource(DASHBOARD_STREAM_URL);
      source = next;
      openedAt = Date.now();
      // EventSource can remain CONNECTING without ever producing an error.
      stale = setTimeout(
        () => retryConnection('Stale — reconnecting'),
        DASHBOARD_STALE_MS,
      );
      next.addEventListener(DASHBOARD_EVENT, (event) => {
        if (disposed || source !== next) return;
        let signal: DashboardSignal;
        try {
          signal = JSON.parse(
            (event as MessageEvent<string>).data,
          ) as DashboardSignal;
          if (
            !['live', 'degraded'].includes(signal.state) ||
            typeof signal.changed !== 'boolean'
          )
            throw new Error('Invalid signal');
        } catch {
          retryConnection('Degraded — reconnecting');
          return;
        }
        clearTimeout(stale);
        stale = setTimeout(
          () => retryConnection('Stale — reconnecting'),
          DASHBOARD_STALE_MS,
        );
        // A brief successful open must not reset backoff for a failing store.
        if (signal.state === 'live' && Date.now() - openedAt >= 30_000)
          retry = 1_000;
        setState(
          signal.state === 'live'
            ? 'Live updates connected'
            : 'Live updates degraded — data may be stale',
        );
        if (signal.changed) {
          setRevision((value) => value + 1);
        }
      });
      next.onerror = () =>
        retryConnection('Disconnected — data may be stale; reconnecting');
    };
    connect();
    return () => {
      disposed = true;
      source?.close();
      clearTimeout(reconnect);
      clearTimeout(stale);
    };
  }, []);
  return (
    <Text
      size="xs"
      c="dimmed"
      ta="right"
      role="status"
      data-testid="live-dashboard-status"
    >
      {pending
        ? 'Updating dashboard'
        : refreshFailed
          ? 'Refresh failed — data may be stale'
          : state}
    </Text>
  );
}
