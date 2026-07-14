import path from 'node:path';

import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { defineConfig, mergeConfig, type UserConfig } from 'vitest/config';

// Shared factory for every migrated project's vitest.config.mts, mirroring
// jest.preset.js's role for Jest projects. Each project config stays a
// one-liner: `createVitestConfig({ dirname: __dirname, projectName: '@repo/x' })`.
export function createVitestConfig(options: {
  dirname: string;
  projectName: string;
  environment?: 'node' | 'jsdom';
  needsFirestoreMockShim?: boolean;
  overrides?: UserConfig;
}) {
  const {
    dirname,
    projectName,
    environment = 'node',
    needsFirestoreMockShim = false,
    overrides = {},
  } = options;
  const projectRelative = path
    .relative(__dirname, dirname)
    .split(path.sep)
    .join('/');

  return mergeConfig(
    defineConfig({
      root: dirname,
      cacheDir: path.join(__dirname, 'node_modules/.vite', projectRelative),
      plugins: [nxViteTsPaths(), nxCopyAssetsPlugin(['*.md'])],
      test: {
        name: projectName,
        watch: false,
        globals: false,
        environment,
        reporters: ['default'],
        setupFiles: needsFirestoreMockShim
          ? [
              path.join(
                __dirname,
                'libs/test-utils/src/firestore/vitest-jest-shim.ts',
              ),
            ]
          : [],
        coverage: {
          reportsDirectory: path.join(__dirname, 'coverage', projectRelative),
          provider: 'v8',
        },
      },
    }),
    defineConfig(overrides),
  );
}
