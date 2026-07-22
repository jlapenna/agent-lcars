import { ComputeLivenessInput, SessionLiveness } from './types';

/** A session is `live` if its transcript was written within this window. */
const LIVE_THRESHOLD_MS = 2 * 60 * 1000;

/** Read-side windows for displayLiveness, deliberately looser than the
 * watcher's write-side LIVE_THRESHOLD_MS: a doc is only as fresh as the
 * watcher's last write, so the display window absorbs one missed tick. */
const DISPLAY_LIVE_THRESHOLD_MS = 5 * 60 * 1000;
const DISPLAY_IDLE_THRESHOLD_MS = 60 * 60 * 1000;
const DISPLAY_OBSERVATION_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Derives liveness from watcher/process signals rather than trusting a raw
 * timestamp comparison alone — a session with a dead process or no watcher
 * heartbeat can't be `live` no matter how recent `lastActivityAt` is.
 */
export function computeLiveness(input: ComputeLivenessInput): SessionLiveness {
  if (!input.heartbeatReceived) {
    return 'stale';
  }
  if (!input.processAlive) {
    return 'ended';
  }
  const ageMs = Date.parse(input.now) - Date.parse(input.lastActivityAt);
  return ageMs <= LIVE_THRESHOLD_MS ? 'live' : 'idle';
}

/**
 * Liveness to *display* for a stored session doc, recomputed at read time.
 *
 * The stored value is only as trustworthy as the watcher that wrote it: a
 * stopped watcher freezes docs at their last liveness forever, and a watcher
 * whose `/proc` process check can't see the session's process (e.g. sessions
 * running in containers) writes `ended` for sessions that are actively
 * streaming. Recent transcript activity is the one signal that can't lie in
 * either direction, so it wins outright; beyond that, a terminal stored
 * state stands, and a non-terminal one decays with age instead of trusting
 * a possibly-frozen `live`.
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
