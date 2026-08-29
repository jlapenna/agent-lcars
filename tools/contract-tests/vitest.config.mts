import path from 'node:path';

import { defineConfig } from 'vitest/config';

import { vitestTsconfigPaths } from '../../vitest.config.base.mts';

// Standalone config for repository tooling and cross-project contracts.
// These tests span the repo root (.github/workflows/*.yml),
// apps/console/src/lib, and operator-only tools that do not belong to an Nx
// application/library project. They run directly via `pnpm check:contracts`
// (see package.json) from the CI Verify job, not through
// `nx run-many -t test`. CI/tooling self-tests (contracts that assert on
// this repo's own CI wiring rather than a production contract) live under
// tools/contract-tests/ci-self/ with their own config and are excluded here
// (docs/testing-policy.md, #1486).
export default defineConfig({
  root: path.resolve(import.meta.dirname, '../..'),
  plugins: [
    vitestTsconfigPaths([
      // Contract tests import console code that reaches shared libraries.
      // Include the workspace alias registry as well as the console's local
      // config so transitive imports (for example work -> dispatch-contracts)
      // resolve the same way they do in the Nx project graph.
      path.resolve(import.meta.dirname, '../../tsconfig.base.json'),
      path.resolve(
        import.meta.dirname,
        '../../apps/console/tsconfig.typecheck.json',
      ),
      path.resolve(
        import.meta.dirname,
        '../../libs/util-server/tsconfig.lib.json',
      ),
      path.resolve(import.meta.dirname, '../../libs/util/tsconfig.lib.json'),
      path.resolve(import.meta.dirname, '../../libs/logging/tsconfig.lib.json'),
      path.resolve(
        import.meta.dirname,
        '../../libs/env-vars/tsconfig.lib.json',
      ),
    ]),
  ],
  resolve: {
    // Keep standalone contract tests aligned with the workspace-wide Vitest
    // config: server modules remain marked for Next.js, while Node-based test
    // runners resolve that marker to the existing no-op test shim.
    alias: {
      'server-only': '@jlapenna/fleet-runtime/vitest/server-only-mock',
    },
  },
  test: {
    include: [
      'tools/contract-tests/**/*.test.ts',
      '!tools/contract-tests/ci-self/**',
      'tools/saved-session/**/*.test.mjs',
      'tools/trajectory-evaluation/**/*.test.mjs',
      'tools/quick-task-evidence-*.test.mjs',
    ],
    watch: false,
    globals: false,
    environment: 'node',
    reporters: ['default'],
  },
});
