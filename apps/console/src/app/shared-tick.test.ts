import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resetSharedTicksForTests,
  sharedTickState,
  subscribeToTick,
} from './shared-tick';

describe('subscribeToTick', () => {
  afterEach(() => {
    resetSharedTicksForTests();
    vi.useRealTimers();
  });

  it('arms one interval per cadence no matter how many subscribers share it', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const unsubscribes = [
      subscribeToTick(30_000, () => undefined),
      subscribeToTick(30_000, () => undefined),
      subscribeToTick(30_000, () => undefined),
    ];

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(sharedTickState()).toEqual({ periods: [30_000], subscribers: 3 });

    for (const unsubscribe of unsubscribes) unsubscribe();
    expect(sharedTickState()).toEqual({ periods: [], subscribers: 0 });
    // The last one out turns the shared timer off; a later subscriber arms a
    // fresh one rather than notifying an empty page.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });

  it('keeps a separate interval per distinct cadence', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const slow = subscribeToTick(30_000, () => undefined);
    const fast = subscribeToTick(10_000, () => undefined);

    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    slow();
    expect(sharedTickState().periods).toEqual([10_000]);
    fast();
    expect(sharedTickState().periods).toEqual([]);
    setIntervalSpy.mockRestore();
  });

  it('delivers each tick to every subscriber, once', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeToTick(10_000, first);
    subscribeToTick(10_000, second);

    vi.advanceTimersByTime(20_000);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);

    unsubscribeFirst();
    vi.advanceTimersByTime(10_000);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(3);
  });

  it('still reaches the subscribers after one unsubscribes mid-tick', () => {
    vi.useFakeTimers();
    const survivors: string[] = [];
    let removeFirst = () => undefined;
    const removeSecond = subscribeToTick(10_000, () => {
      // A real subscriber can unmount its own component while the tick is
      // being delivered.
      removeFirst();
    });
    removeFirst = subscribeToTick(10_000, () => {
      survivors.push('reached');
    });
    subscribeToTick(10_000, () => {
      survivors.push('after');
    });

    vi.advanceTimersByTime(10_000);
    expect(survivors).toEqual(['reached', 'after']);
    removeSecond();
  });

  it('is idempotent for repeated unsubscribes', () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    const unsubscribe = subscribeToTick(10_000, listener);
    unsubscribe();
    unsubscribe();

    expect(sharedTickState()).toEqual({ periods: [], subscribers: 0 });
    vi.advanceTimersByTime(30_000);
    expect(listener).not.toHaveBeenCalled();
  });
});
