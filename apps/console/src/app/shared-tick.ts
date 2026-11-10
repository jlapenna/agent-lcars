/**
 * One `setInterval` per cadence, shared by every subscriber on the page.
 *
 * Every time-derived label in the console used to arm its own interval: a
 * `RelativeTime` per visible timestamp (33 call sites) plus one per mounted
 * `ExecutionStatus`. A Work list with a few dozen rows therefore ran
 * hundreds of independent timers, each firing its own state update at its own
 * phase — many separate React renders spread through the tick window instead
 * of one coalesced batch, and hundreds of host timer handles to schedule.
 *
 * This registry keeps a single interval per period and notifies subscribers
 * from it, so all labels on a page advance together in one React batch and
 * the timer count is the number of distinct cadences, not the number of rows.
 * The interval is reference-counted: it is cleared when the last subscriber
 * leaves, so a page with no visible timestamps arms nothing.
 *
 * The notification loop copies the listener set before iterating, so a
 * subscriber that unsubscribes during a tick cannot skip the listeners after
 * it, and a subscriber that subscribes during a tick is not called until the
 * next one.
 */

type TickListener = () => void;

const listenersByPeriod = new Map<number, Set<TickListener>>();
const timersByPeriod = new Map<number, ReturnType<typeof setInterval>>();

/** Register `listener` on the shared ticker for `periodMs`. Returns the
 * unsubscribe; calling it more than once is harmless. */
export function subscribeToTick(
  periodMs: number,
  listener: TickListener,
): () => void {
  let listeners = listenersByPeriod.get(periodMs);
  if (!listeners) {
    listeners = new Set();
    listenersByPeriod.set(periodMs, listeners);
  }
  listeners.add(listener);

  if (!timersByPeriod.has(periodMs)) {
    timersByPeriod.set(
      periodMs,
      setInterval(() => {
        // Snapshot first: a listener is allowed to unmount its own component
        // (and unsubscribe) while the tick is being delivered.
        for (const current of [...(listenersByPeriod.get(periodMs) ?? [])]) {
          current();
        }
      }, periodMs),
    );
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = listenersByPeriod.get(periodMs);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      clearInterval(timersByPeriod.get(periodMs));
      timersByPeriod.delete(periodMs);
      listenersByPeriod.delete(periodMs);
    }
  };
}

/** For tests: assert nothing leaked a shared ticker between cases. */
export function sharedTickState(): { periods: number[]; subscribers: number } {
  let subscribers = 0;
  for (const listeners of listenersByPeriod.values())
    subscribers += listeners.size;
  return { periods: [...listenersByPeriod.keys()], subscribers };
}

/**
 * For tests: drop every subscription and its timer.
 *
 * A Vitest case swaps the global timer implementation out from under this
 * module (`vi.useFakeTimers()`), which orphans the id already recorded for a
 * period without clearing it. The reference count would then say the period is
 * armed while the clock that could fire it no longer exists, so the next case
 * that subscribes never re-arms and sees no tick. Production has exactly one
 * timer implementation for the life of the page, so this state cannot occur
 * there; the reset exists so a case starts from an honest empty registry.
 */
export function resetSharedTicksForTests(): void {
  for (const timer of timersByPeriod.values()) clearInterval(timer);
  timersByPeriod.clear();
  listenersByPeriod.clear();
}
