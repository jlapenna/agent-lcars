import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// @testing-library/react's own auto-cleanup only registers itself when it
// finds a global `afterEach` (`typeof afterEach === 'function'` on
// globalThis); this repo's vitest.config.base.mts sets `globals: false`, so
// that global never exists and DOM from one test leaks into the next test
// in the same file — assertions like `queryByText(...).toBeNull()` then see
// a stale element rendered by an earlier test instead of a clean document.
// Wiring cleanup explicitly here (this setupFile always loads alongside
// `@testing-library/jest-dom/vitest`, i.e. wherever RTL is in use) fixes it
// regardless of `globals`.
afterEach(() => {
  cleanup();
});
