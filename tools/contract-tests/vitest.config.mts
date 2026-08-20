import path from 'node:path';

import { defineConfig } from 'vitest/config';

import { vitestTsconfigPaths } from '../../vitest.config.base.mts';

// Standalone config for repository tooling and cross-project contracts.
// These tests span the repo root (.github/workflows/*.yml),
// apps/console/src/lib, and operator-only tools that do not belong to an Nx
// application/library project. They run directly via `pnpm check:contracts`
// (see package.json) from the CI Verify job, not through
// `nx run-many -t test`.
export default defineConfig({
  root: path.resolve(import.meta.dirname, '../..'),
  plugins: [
    vitestTsconfigPaths([
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
