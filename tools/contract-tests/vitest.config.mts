import path from 'node:path';

import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

// Standalone config for tools/contract-tests: these tests span the repo
// root (.github/workflows/*.yml) and apps/console/src/lib, so they don't
// belong to any single Nx project's vitest.config.mts. They run directly
// via `pnpm check:contracts` (see package.json) from the CI Verify job,
// not through `nx run-many -t test`.
export default defineConfig({
  root: path.resolve(__dirname, '../..'),
  plugins: [tsconfigPaths()],
  test: {
    include: ['tools/contract-tests/**/*.test.ts'],
    watch: false,
    globals: false,
    environment: 'node',
    reporters: ['default'],
  },
});
