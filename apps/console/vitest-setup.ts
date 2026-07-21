// Vitest sibling of test-setup.ts (#2933/#2959/#2997/#3002/#3004).
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// @testing-library/react only self-registers its per-test `cleanup()` when
// it finds a global `afterEach` (dist/index.js: `typeof afterEach ===
// 'function'`) — true unconditionally under Jest, but only true here if
// `test.globals: true`. The shared factory deliberately sets `globals:
// false` (matches this repo's explicit-import style), so every DOM-tier
// project needs this manually, or later tests in the same file/describe
// see a stale, already-rendered tree.
afterEach(cleanup);

window.HTMLElement.prototype.scrollIntoView = vi.fn();

class ResizeObserver {
  observe() {
    // mock
  }
  unobserve() {
    // mock
  }
  disconnect() {
    // mock
  }
}
window.ResizeObserver = ResizeObserver;

// jsdom has no `document.fonts` — Mantine's Textarea autosize
// (Autosize.mjs) unconditionally calls
// `document.fonts.addEventListener('loadingdone', ...)`, throwing
// "Cannot read properties of undefined (reading 'addEventListener')"
// the moment any autosizing Textarea mounts (docs/vitest-pilot.md,
// primes/frontend's vitest-setup.ts has the same polyfill).
if (typeof document !== 'undefined' && !document.fonts) {
  (document as unknown as { fonts: unknown }).fonts = {
    addEventListener: () => {
      // noop
    },
    removeEventListener: () => {
      // noop
    },
  };
}
