import { describe, expect, it } from 'vitest';

import { installTimerTracking, sweepArmedTimers } from './timer-hygiene';

/**
 * The shared vitest-setup installs this tracking and sweeps once per test
 * file (#1871); these assert the mechanism directly rather than relying on
 * hook ordering, so a failure points at the sweep rather than at whichever
 * suite happened to lose the race.
 */
describe('timer hygiene', () => {
  it('cancels a timeout that would have outlived the file', async () => {
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 20);

    expect(sweepArmedTimers().timeouts).toBeGreaterThan(0);

    // Waited with the real timer that the sweep just proved it cancels, so
    // this also confirms the sweep leaves timing working afterwards.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fired).toBe(false);
  });

  it('cancels a leaked interval', async () => {
    let ticks = 0;
    setInterval(() => {
      ticks += 1;
    }, 10);
    await new Promise((resolve) => setTimeout(resolve, 35));
    // Proves the interval really was running, so the assertion below is
    // about the sweep and not about an interval that never started.
    expect(ticks).toBeGreaterThan(0);

    expect(sweepArmedTimers().intervals).toBe(1);
    const ticksAtSweep = ticks;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(ticks).toBe(ticksAtSweep);
  });

  it('leaves an already-fired timeout out of the sweep', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The awaited timer has already run, so nothing is left to cancel --
    // without the settle wrapper that forgets fired ids, the tracking set
    // would grow for the life of the suite instead.
    expect(sweepArmedTimers().timeouts).toBe(0);
  });

  it('forgets a timeout that was cleared normally', () => {
    const id = setTimeout(() => undefined, 1000);
    clearTimeout(id);
    expect(sweepArmedTimers().timeouts).toBe(0);
  });

  it('is idempotent, so a second install does not double-wrap', () => {
    const before = globalThis.setTimeout;
    installTimerTracking();
    expect(globalThis.setTimeout).toBe(before);
  });
});
