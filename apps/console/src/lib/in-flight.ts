import { isE2eTesting } from '@agent-lcars/util-server';

/**
 * Shares one read between requests that ask for it while it is still in
 * flight on this instance, and keeps nothing once it settles. A browser's
 * first load renders a page and fetches the console frame's readouts at the
 * same moment, and both read the queue, agent activity and native Inbox
 * cards; on a one-CPU instance doing that work twice made the page wait for
 * both. A request that joins gets a read that started at most one read's
 * duration earlier, never a stored copy.
 *
 * Held on `globalThis` because pages and Route Handlers run in separate
 * module graphs in one JS realm (see session-archive.ts). Hermetic E2E reads
 * alone: a fixture reset must not hand a later request a read started
 * before it.
 */
const IN_FLIGHT_KEY = '__agentLcarsInFlightReads';

export function shareInFlight<T>(
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  if (isE2eTesting()) return read();
  const realm = globalThis as Record<string, unknown>;
  const pending = (realm[IN_FLIGHT_KEY] ??= new Map()) as Map<
    string,
    Promise<unknown>
  >;
  const joined = pending.get(key);
  if (joined) return joined as Promise<T>;
  const started: Promise<T> = read().finally(() => {
    if (pending.get(key) === started) pending.delete(key);
  });
  pending.set(key, started);
  return started;
}
