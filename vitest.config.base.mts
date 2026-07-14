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
  needsJestDomMatchers?: boolean;
  needsMatchMediaMock?: boolean;
  overrides?: UserConfig;
}) {
  const {
    dirname,
    projectName,
    environment = 'node',
    needsFirestoreMockShim = false,
    needsJestDomMatchers = false,
    needsMatchMediaMock = false,
    overrides = {},
  } = options;
  const projectRelative = path
    .relative(__dirname, dirname)
    .split(path.sep)
    .join('/');

  const setupFiles = [
    ...(needsFirestoreMockShim
      ? [
          path.join(
            __dirname,
            'libs/test-utils/src/firestore/vitest-jest-shim.ts',
          ),
        ]
      : []),
    ...(needsJestDomMatchers
      ? [
          path.join(
            __dirname,
            'libs/test-utils/src/dom/vitest-jest-dom-setup.ts',
          ),
        ]
      : []),
    ...(needsMatchMediaMock
      ? [
          path.join(
            __dirname,
            'libs/test-utils/src/dom/vitest-matchmedia-mock.ts',
          ),
        ]
      : []),
  ];

  return mergeConfig(
    defineConfig({
      root: dirname,
      cacheDir: path.join(__dirname, 'node_modules/.vite', projectRelative),
      plugins: [nxViteTsPaths(), nxCopyAssetsPlugin(['*.md'])],
      resolve: {
        // Mirrors jest.preset.js's workspace-wide `server-only` ->
        // server-only-mock.js moduleNameMapper entry. Without this, any
        // test that imports (directly, or transitively via automocking) a
        // module whose chain touches the real `server-only` package throws
        // "This module cannot be imported from a Client Component module" —
        // Jest's mapper intercepts it globally regardless of whether the
        // importing module itself is mocked; Vitest needs the equivalent
        // as a resolve alias since it has no moduleNameMapper concept.
        alias: {
          'server-only': path.join(
            __dirname,
            'libs/test-utils/src/server-only-mock.js',
          ),
        },
      },
      test: {
        name: projectName,
        watch: false,
        globals: false,
        environment,
        passWithNoTests: true,
        reporters: ['default'],
        // Mirrors jest.preset.js's targetDefaults.test passWithNoTests:true
        // — some migrated libs (e.g. type-only or index-only packages) have
        // no test files at all.
        passWithNoTests: true,
        setupFiles,
        coverage: {
          reportsDirectory: path.join(__dirname, 'coverage', projectRelative),
          provider: 'v8',
        },
      },
    }),
    defineConfig(overrides),
  );
}
