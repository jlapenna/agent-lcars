import type { CliSessionDoc, SessionLiveness } from './types';

/** Read-side windows for displayLiveness: a stored session doc is only as fresh
 * as its last hook/finalize write, so the display window absorbs brief gaps
 * between transcript events before decaying non-terminal states. */
const DISPLAY_LIVE_THRESHOLD_MS = 5 * 60 * 1000;
const DISPLAY_IDLE_THRESHOLD_MS = 60 * 60 * 1000;
const DISPLAY_OBSERVATION_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Liveness to *display* for a stored session doc, recomputed at read time.
 *
 * Recent transcript activity wins outright; beyond that, a recent live/idle
 * hook observation stands within `DISPLAY_OBSERVATION_THRESHOLD_MS`, a terminal
 * stored state stands, and an older non-terminal one decays with age instead of
 * trusting a frozen `live`.
 */
export function displayLiveness(
  stored: SessionLiveness,
  lastActivityAt: string,
  now: string,
  observedAt?: string,
): SessionLiveness {
  const ageMs = Date.parse(now) - Date.parse(lastActivityAt);
  if (ageMs <= DISPLAY_LIVE_THRESHOLD_MS) return 'live';
  const observationAgeMs = observedAt
    ? Date.parse(now) - Date.parse(observedAt)
    : Number.POSITIVE_INFINITY;
  if (
    observationAgeMs <= DISPLAY_OBSERVATION_THRESHOLD_MS &&
    (stored === 'live' || stored === 'idle')
  ) {
    return stored;
  }
  if (stored === 'ended' || stored === 'stale') return stored;
  return ageMs <= DISPLAY_IDLE_THRESHOLD_MS ? 'idle' : 'ended';
}

/**
 * The herdr terminal a stored CLI session can still be watched in, or
 * `undefined` once the session has recorded its end.
 *
 * {@link displayLiveness} shows a session as `live` for a few minutes after
 * its last activity even when it has ended, so the display value alone would
 * keep offering a terminal the session has already left.
 */
export function watchableHerdrPaneId(
  doc: Pick<CliSessionDoc, 'liveness' | 'herdrPaneId'>,
): string | undefined {
  return doc.liveness === 'ended' || doc.liveness === 'stale'
    ? undefined
    : doc.herdrPaneId;
}
