/**
 * No timer armed by a test file may outlive that file (#1871).
 *
 * A pending `setTimeout` whose callback touches React survives its test
 * file, fires on the Node event loop after Vitest tears the file's jsdom
 * down, and throws `ReferenceError: window is not defined`. Vitest fails a
 * run on an unhandled error even when every assertion passed, so the whole
 * suite goes red -- and only sometimes, since whether the timer beats
 * teardown depends on machine load. That flake reddened an unrelated PR's
 * Verify (#1868) and survived six consecutive isolated runs of the file it
 * came from, which is exactly the kind of failure nobody can reproduce on
 * the workstation it blocks.
 *
 * Components already clear their own timers on unmount, and `cleanup()`
 * unmounts them -- Mantine's Transition and WorkCreateForm's retry both do
 * this correctly. This is the backstop for whatever does not.
 *
 * ## Why the sweep is per file, not per test
 *
 * Sweeping after every test also cancels React's own scheduler callback:
 * jsdom has no MessageChannel for React 19's scheduler to prefer, so it
 * falls back to a timer, and cancelling one mid-flight wedges the work loop
 * for every later test in the file. That is not theoretical -- it broke all
 * 26 of item-overflow-menu.test.tsx (menus stopped opening, because the
 * render that would have opened them never flushed).
 *
 * A stray timer between two tests is harmless: it fires into a live jsdom.
 * The file boundary is the one that matters, because that is where the DOM
 * it closes over is destroyed.
 *
 * ## What this routinely cancels, and why that is not a bug list
 *
 * A non-zero sweep is normal. Recording a creation stack for every armed
 * timer and running the whole suite turns up three kinds of entry, none of
 * which is a defect in this repo:
 *
 * - **jsdom's own 0 ms event timers.** `localStorage.setItem` queues a
 *   `storage` event, `focus()` a selection change, `<details>` a `toggle`,
 *   an anchor click a navigation -- each via `setTimeout(..., 0)` inside
 *   jsdom. The stack names *our* call site (`use-muted-items.ts`,
 *   `persisted-details.tsx`, ...), which makes them read like application
 *   leaks; they are not. They fire on the next tick and never touch React.
 * - **`@octokit/plugin-throttling`'s bottleneck housekeeping**, a 60 s
 *   interval per client, armed when a test constructs an Octokit.
 * - **This module's own tests**, which leak on purpose to prove the sweep.
 *
 * Every timer this repo's console source arms was audited against that
 * list: the four `setInterval`s (data-freshness, relative-time,
 * refresh-button, runner-autoscaler-status) all `clearInterval` in their
 * effect cleanup, and the two `await new Promise(resolve =>
 * setTimeout(resolve, ...))` always fire. The one real leak was
 * work-create-form's queued retry, fixed in #1873.
 *
 * So read a non-zero count as "the sweep did its job", not as a bug to
 * chase -- and when chasing one anyway, capture the stack rather than
 * trusting the frame beneath it, which is the mistake that produced a
 * five-item list of leaks that did not exist.
 */

/**
 * Timer ids are kept opaque on purpose. This file is typechecked with both
 * the DOM and Node timer declarations in scope, where `setTimeout` returns
 * `number` and `Timeout` respectively; naming either one makes the other a
 * type error, and neither is the "right" one to pick since which is live
 * depends on the environment the test file runs in.
 */
type TimerId = unknown;

const armedTimeouts = new Set<TimerId>();
const armedIntervals = new Set<TimerId>();

let installed = false;
let cancelTimeout: (id: TimerId) => void = () => undefined;
let cancelInterval: (id: TimerId) => void = () => undefined;

/**
 * Wraps the global timer functions so {@link sweepArmedTimers} knows what is
 * still pending. Idempotent: a second call is a no-op rather than a wrapper
 * around a wrapper.
 *
 * jsdom's `window` *is* `globalThis` under Vitest's jsdom environment (the
 * same object, timer functions included), so patching the global also
 * covers a library reaching for `window.setTimeout` -- which is how
 * Mantine's Transition arms the timer that started all this.
 */
export function installTimerTracking(): void {
  if (installed) return;
  installed = true;

  const nativeSetTimeout = globalThis.setTimeout;
  const nativeSetInterval = globalThis.setInterval;
  const nativeClearTimeout = globalThis.clearTimeout as (id: TimerId) => void;
  const nativeClearInterval = globalThis.clearInterval as (id: TimerId) => void;
  cancelTimeout = nativeClearTimeout;
  cancelInterval = nativeClearInterval;

  globalThis.setTimeout = Object.assign(function trackedSetTimeout(
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ): TimerId {
    const armed: { id?: TimerId } = {};
    // Forget the id the moment it fires: a timer that has already run is
    // not a leak, and holding its id would grow the set all suite long.
    const settle =
      typeof handler === 'function'
        ? (...callbackArgs: unknown[]) => {
            if (armed.id !== undefined) armedTimeouts.delete(armed.id);
            (handler as (...callbackArgs: unknown[]) => void)(...callbackArgs);
          }
        : handler;
    armed.id = nativeSetTimeout(settle as TimerHandler, timeout, ...args);
    armedTimeouts.add(armed.id);
    return armed.id;
  }, nativeSetTimeout) as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((id?: TimerId) => {
    if (id !== undefined) armedTimeouts.delete(id);
    nativeClearTimeout(id);
  }) as typeof globalThis.clearTimeout;

  globalThis.setInterval = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    // No settle wrapper: an interval only stops when something clears it.
    const id = nativeSetInterval(handler, timeout, ...args);
    armedIntervals.add(id);
    return id;
  }) as typeof globalThis.setInterval;

  globalThis.clearInterval = ((id?: TimerId) => {
    if (id !== undefined) armedIntervals.delete(id);
    nativeClearInterval(id);
  }) as typeof globalThis.clearInterval;
}

/**
 * Cancels every timer still armed, and reports how many there were. Called
 * from the shared setup's `afterAll`, once the file's last test has run and
 * nothing else needs the scheduler.
 */
export function sweepArmedTimers(): { timeouts: number; intervals: number } {
  const swept = {
    timeouts: armedTimeouts.size,
    intervals: armedIntervals.size,
  };
  for (const id of armedTimeouts) cancelTimeout(id);
  armedTimeouts.clear();
  for (const id of armedIntervals) cancelInterval(id);
  armedIntervals.clear();
  return swept;
}
