// Vitest sibling of test-setup.ts (#2933/#2959/#2997/#3002/#3004).
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

const TEST_HOME_REPOSITORY = 'jlapenna/agent-lcars';
const TEST_WATCHED_REPOS = JSON.stringify([
  { owner: 'jlapenna', name: 'agent-lcars' },
]);

// Repository identity is intentionally explicit in every deployed runtime.
// Supply the same complete configuration to each unit test; individual tests
// can still delete or replace a variable to assert malformed-config failures.
//
// The four values below back apps/console/src/lib/deployment.ts's
// `required()` deployment-identity accessors (#1731: no jlapenna-shaped
// fallback in source any more) -- every test that reaches one of them
// (directly, or transitively, e.g. e2e-github-fixtures.ts's module-scope
// `maintainerLogin()` call) needs a value here, since production no longer
// supplies one for free.
function applyIdentityDefaults() {
  process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORY'] ??= TEST_HOME_REPOSITORY;
  process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] ??=
    TEST_HOME_REPOSITORY;
  process.env['AGENT_LCARS_WATCHED_REPOS'] ??= TEST_WATCHED_REPOS;
  process.env['AGENT_LCARS_ADMIN_GITHUB_LOGIN'] ??= 'jlapenna';
  process.env['AGENT_LCARS_CONSOLE_URL'] ??= 'https://lcars.jlapenna.net';
  process.env['AGENT_LCARS_ARTIFACT_SHARE_BASE_URL'] ??=
    'https://share.lan.jlapenna.net';
  process.env['AGENT_LCARS_PUSH_WATCH_TARGET_REPO'] ??= 'jlapenna/homelab';
}

// Applied once, unconditionally, at module load -- setupFiles run before the
// test file itself is imported, so this is what covers a `required()` read
// at the test file's own module scope (e2e-github-fixtures.ts's
// `maintainerLogin()`); a `beforeEach` alone would run too late for that.
applyIdentityDefaults();

beforeEach(applyIdentityDefaults);

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
