import path from 'node:path';

import { defineConfig } from 'vitest/config';

import { vitestTsconfigPaths } from '../../../vitest.config.base.mts';

// Standalone config for the CI/tooling self-tests: contract tests that
// assert on this repo's own CI wiring (the E2E operational gate, the
// resolved ESLint guardrail/baseline configs) rather than on a production
// contract. Split out of tools/contract-tests/vitest.config.mts (and the
// required `Check contracts` step) per the maintainer decision recorded in
// docs/testing-policy.md (#1486): the required PR pipeline must not block
// on checks that test the test/CI infrastructure itself. These run from
// `pnpm check:contracts:ci-self` in the advisory `.github/workflows/ci-tooling.yml`
// workflow, not through `pnpm check:contracts` / the required `Verify` check.
export default defineConfig({
  root: path.resolve(import.meta.dirname, '../../..'),
  plugins: [
    vitestTsconfigPaths([
      path.resolve(
        import.meta.dirname,
        '../../../apps/console/tsconfig.typecheck.json',
      ),
      path.resolve(
        import.meta.dirname,
        '../../../libs/util-server/tsconfig.lib.json',
      ),
      path.resolve(import.meta.dirname, '../../../libs/util/tsconfig.lib.json'),
      path.resolve(
        import.meta.dirname,
        '../../../libs/logging/tsconfig.lib.json',
      ),
      path.resolve(
        import.meta.dirname,
        '../../../libs/env-vars/tsconfig.lib.json',
      ),
    ]),
  ],
  resolve: {
    // Keep this standalone config aligned with the workspace-wide Vitest
    // config: server modules remain marked for Next.js, while Node-based
    // test runners resolve that marker to the existing no-op test shim.
    alias: {
      'server-only': '@jlapenna/fleet-runtime/vitest/server-only-mock',
    },
  },
  test: {
    include: ['tools/contract-tests/ci-self/**/*.test.ts'],
    watch: false,
    globals: false,
    environment: 'node',
    reporters: ['default'],
  },
});
