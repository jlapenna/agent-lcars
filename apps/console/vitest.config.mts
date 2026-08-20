import path from 'node:path';

import { createVitestConfig } from '../../vitest.config.base.mts';

// Real migration (#2933/#2959/#2997/#3002/#3004). No test.exclude
// carve-out needed: this app has no firestore-jest-mock/jest.doMock
// usage at all.
export default createVitestConfig({
  dirname: import.meta.dirname,
  projectName: '@agent-lcars/console',
  environment: 'jsdom',
  needsJestDomMatchers: true,
  needsMatchMediaMock: true,
  overrides: {
    // Next.js's own tsconfig forces `"jsx": "preserve"` (its SWC compiler
    // does the JSX transform, not tsc) — Vite 8's default oxc transform
    // picks that up from the nearest tsconfig.json and passes raw JSX
    // through untransformed (docs/vitest-pilot.md, primes/frontend).
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: {
      alias: {
        // The shared compatibility plugin resolves workspace mappings, but
        // this app-local `"@/*": ["./src/*"]` alias is kept explicit so the
        // test config does not depend on tsconfig discovery order.
        '@': path.join(import.meta.dirname, 'src'),
        // jest.preset.js globally maps `server-only` to a no-op via
        // `moduleNameMapper`; Vitest has no config-level equivalent of a
        // *global* moduleNameMapper, so each Next.js app's
        // vitest.config.mts needs this alias explicitly even though the
        // shared base config also declares it (mergeConfig's handling of
        // nested `resolve.alias` isn't reliable enough to skip
        // re-declaring it here — matches Sprinkles/OneCake frontend
        // precedent).
        'server-only': '@jlapenna/fleet-runtime/vitest/server-only-mock',
        'next/server': path.join(
          import.meta.dirname,
          '../../node_modules/next/server.js',
        ),
      },
    },
    test: {
      setupFiles: [path.join(import.meta.dirname, 'vitest-setup.ts')],
      testTimeout: 30000,
      server: {
        deps: {
          inline: ['next-auth'],
        },
      },
      exclude: ['**/node_modules/**'],
    },
  },
});
