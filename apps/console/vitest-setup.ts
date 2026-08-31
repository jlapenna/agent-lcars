// Vitest sibling of test-setup.ts (#2933/#2959/#2997/#3002/#3004).
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

const TEST_HOME_REPOSITORY = 'jlapenna/agent-lcars';
const TEST_WATCHED_REPOSITORIES = [
  { owner: 'jlapenna', name: 'agent-lcars' },
  { owner: 'supersprinklesracing', name: 'sprinkles', alias: 'sprinkles' },
] as const;
const TEST_WATCHED_REPOS = JSON.stringify(TEST_WATCHED_REPOSITORIES);
const TEST_CONTROL_PLANE_REPOSITORIES = TEST_WATCHED_REPOSITORIES.map(
  ({ owner, name }) => `${owner}/${name}`,
).join(',');

// Repository identity is intentionally explicit in every deployed runtime.
// Supply the same complete configuration to each unit test; individual tests
// can still delete or replace a variable to assert malformed-config failures.
beforeEach(() => {
  process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORY'] ??= TEST_HOME_REPOSITORY;
  process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] ??=
    TEST_CONTROL_PLANE_REPOSITORIES;
  process.env['AGENT_LCARS_WATCHED_REPOS'] ??= TEST_WATCHED_REPOS;
});

// @testing-library/react only self-registers its per-test `cleanup()` when
// it finds a global `afterEach` (dist/index.js: `typeof afterEach ===
// 'function'`) — true unconditionally under Jest, but only true here if
// `test.globals: true`. The shared factory deliberately sets `globals:
// false` (matches this repo's explicit-import style), so every DOM-tier
// project needs this manually, or later tests in the same file/describe
// see a stale, already-rendered tree.
afterEach(cleanup);

// Guarded rather than unconditional: a `// @vitest-environment node` test
// file (e.g. github-app-tokens.test.ts -- real WebCrypto RSA signing is
// unreliable under jsdom's window, see that file's comment) still runs
// this shared setup file, but has no `window` at all. Every jsdom-tier
// test still gets the exact same setup as before.
if (typeof window !== 'undefined') {
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
}

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
