import { vi } from 'vitest';

(globalThis as any).jest = {
  fn: vi.fn,
  mock: () => undefined,
  doMock: () => undefined,
  unmock: () => undefined,
  dontMock: () => undefined,
  advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
  advanceTimersToNextTimer: () => vi.advanceTimersToNextTimer(),
  runAllTimers: () => vi.runAllTimers(),
  runOnlyPendingTimers: () => vi.runOnlyPendingTimers(),
  useFakeTimers: (options?: Parameters<typeof vi.useFakeTimers>[0]) =>
    vi.useFakeTimers(options),
  useRealTimers: () => vi.useRealTimers(),
  clearAllTimers: () => vi.clearAllTimers(),
};
