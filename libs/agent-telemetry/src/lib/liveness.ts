import { ComputeLivenessInput, SessionLiveness } from './types';

/** A session is `live` if its transcript was written within this window. */
const LIVE_THRESHOLD_MS = 2 * 60 * 1000;

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
