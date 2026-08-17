import { vi } from 'vitest';

// firestore-jest-mock calls the global `jest.fn()` at module scope (e.g.
// mocks/fieldValue.js's `const mockIncrementFieldValue = jest.fn();`), which
// doesn't exist under Vitest. This is the minimal shim its `FakeFirestore`
// code path actually needs.
//
// Deliberately does NOT also shim `jest.doMock` for
// `mockGoogleCloudFirestore`/`mockFirebase` (firestore-jest-mock's other
// entry points, used by e.g. sprinkles' libs/preems test-setup.ts): tried aliasing
// it to `vi.doMock` (2026-07-15) and it hangs indefinitely with zero test
// output, not just fails - `jest.doMock` intercepts Node's `require()` at
// Jest's own module-loader level, and Vitest's Vite-based SSR module graph
// has no equivalent that can transparently intercept an already-partially-
// resolved CJS package (`@google-cloud/firestore`) the way Jest does. This
// confirms the same finding from the primes/frontend spike (sprinkles#2952/#2957)
// transfers here — projects using `mockGoogleCloudFirestore` need
// `test-setup.server.ts`-style setup code rewritten against `vi.mock`
// directly, not a shim. Not fixable here; affects only sprinkles' libs/preems among
// the sprinkles#2933 migration's remaining scope.
//
// jest-fetch-mock's default export (`import fetchMock from 'jest-fetch-mock'`)
// has the same jest.fn() requirement - it's `createFetchMock(jest)`
// evaluated at import time - so this same shim also covers any project's
// fetch mocking (see createVitestConfig's `needsJestFnShim`).
Object.assign(globalThis, {
  jest: {
    fn: vi.fn,
    mock: () => {
      // noop
    },
    doMock: () => {
      // noop
    },
    unmock: () => {
      // noop
    },
    dontMock: () => {
      // noop
    },
    advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
    advanceTimersToNextTimer: () => vi.advanceTimersToNextTimer(),
    runAllTimers: () => vi.runAllTimers(),
    runOnlyPendingTimers: () => vi.runOnlyPendingTimers(),
    useFakeTimers: (options?: Parameters<typeof vi.useFakeTimers>[0]) =>
      vi.useFakeTimers(options),
    useRealTimers: () => vi.useRealTimers(),
    clearAllTimers: () => vi.clearAllTimers(),
  },
});
