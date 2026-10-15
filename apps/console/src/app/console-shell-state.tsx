'use client';

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';

import type { ShellIdentity, ShellReadouts } from '../lib/shell-readouts';

/* ---- Live status ----
   `LiveDashboard` (mounted by the live routes) publishes its stream state
   here so the header can show it. Routes without a live stream leave the
   store empty and the header reports a page snapshot instead. */

export type LiveMode = 'live' | 'connecting' | 'degraded' | 'updating';

export interface LiveState {
  mode: LiveMode;
  /** The stream's own human-readable state, for the accessible label. */
  label: string;
  /** When the page last applied fresh data. */
  syncedAt?: number;
}

let liveState: LiveState | undefined;
const liveListeners = new Set<() => void>();

export function publishLiveState(next: LiveState | undefined) {
  liveState = next;
  for (const listener of liveListeners) listener();
}

function subscribeLive(listener: () => void) {
  liveListeners.add(listener);
  return () => liveListeners.delete(listener);
}

export function useLiveState(): LiveState | undefined {
  return useSyncExternalStore(
    subscribeLive,
    () => liveState,
    () => undefined,
  );
}

/* ---- Frame readouts ----
   One request per page load for the rail, the destination counts and the
   identity block, refreshed every 30s. Absent figures render as
   unavailable, never zero. (Not on every live-stream refresh: each read
   rebuilds the decision snapshot, and the stream can refresh every 5s.) */

const READOUTS_URL = '/api/console/shell-readouts';
const READOUTS_REFRESH_MS = 30_000;

type ReadoutsState =
  | { status: 'loading' }
  | { status: 'ready'; readouts: ShellReadouts }
  | { status: 'unavailable' };

const LOADING: ReadoutsState = { status: 'loading' };
let readoutsState: ReadoutsState = LOADING;
let inFlight: Promise<void> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let subscribers = 0;
const readoutListeners = new Set<() => void>();

function setReadouts(next: ReadoutsState) {
  readoutsState = next;
  for (const listener of readoutListeners) listener();
}

export function refreshShellReadouts(): Promise<void> {
  inFlight ??= fetch(READOUTS_URL, { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setReadouts({
        status: 'ready',
        readouts: (await response.json()) as ShellReadouts,
      });
    })
    .catch(() => {
      // Keep the last good figures across a transient failure.
      if (readoutsState.status !== 'ready')
        setReadouts({ status: 'unavailable' });
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

function subscribeReadouts(listener: () => void) {
  readoutListeners.add(listener);
  if (++subscribers === 1) {
    void refreshShellReadouts();
    timer = setInterval(() => void refreshShellReadouts(), READOUTS_REFRESH_MS);
  }
  return () => {
    readoutListeners.delete(listener);
    if (--subscribers === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useShellReadouts(): ReadoutsState {
  return useSyncExternalStore(
    subscribeReadouts,
    () => readoutsState,
    () => LOADING,
  );
}

/* ---- Identity ----
   The root layout reads who is signed in, so the identity block and the
   environment line render with the first paint instead of shifting the
   header when the readouts arrive. The readouts' copy wins once present. */

const IdentityContext = createContext<ShellIdentity | undefined>(undefined);

export function ShellIdentityProvider({
  identity,
  children,
}: {
  identity: ShellIdentity | undefined;
  children: ReactNode;
}) {
  return (
    <IdentityContext.Provider value={identity}>
      {children}
    </IdentityContext.Provider>
  );
}

export function useShellIdentity(): ShellIdentity | undefined {
  const state = useShellReadouts();
  const served = useContext(IdentityContext);
  return state.status === 'ready' ? state.readouts : served;
}

/** For tests: forget cached figures and live state between renders. */
export function resetShellStateForTests() {
  readoutsState = LOADING;
  inFlight = undefined;
  liveState = undefined;
}

/* ---- Formatting ---- */

export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString('en-US');
}

/** Year and day of year, e.g. 2026.286 (UTC). */
export function stardate(date: Date): string {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = Math.floor((date.getTime() - start) / 86_400_000);
  return `${date.getUTCFullYear()}.${String(day).padStart(3, '0')}`;
}

/** Re-renders once a minute so time-derived text stays current. */
export function useMinuteClock(): Date | undefined {
  const [now, setNow] = useState<Date>();
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
