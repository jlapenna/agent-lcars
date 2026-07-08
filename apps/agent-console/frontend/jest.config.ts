import { createRequire } from 'node:module';

import type { Config } from 'jest';
import nextJest from 'next/jest.js';

// This config runs as ESM, so pull the CJS workspace preset in via
// createRequire: its moduleNameMapper carries the per-lib and subpath
// (@repo/x/server, /browser, ...) mappings the catch-all below can't express.
const requireCjs = createRequire(import.meta.url);
const workspacePreset = requireCjs('../../../jest.preset.js') as {
  moduleNameMapper?: Record<string, string>;
};

const createJestConfig = nextJest({
  dir: './',
});

const esmModules = [
  'p-wait-for',
  '@auth/firebase-adapter',
  '@auth/core',
  'jose',
  'oauth4webapi',
  'undici',
  'next-auth',
  'p-limit',
  'yocto-queue',
].join('|');

const customJestConfig: Config = {
  displayName: '@repo/agent-console/frontend',
  preset: '../../../jest.preset.js',
  workerIdleMemoryLimit: '512MB',
  transform: {
    '^(?!.*\\.(js|jsx|ts|tsx|css|json)$)': '@nx/react/plugins/jest',
  },
  transformIgnorePatterns: [
    `node_modules/(?!(.pnpm/(.+/node_modules/)?(${esmModules})|(${esmModules})))`,
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  coverageDirectory: 'test-output/jest/coverage',
  testEnvironment: 'jsdom',
  testEnvironmentOptions: {
    customExportConditions: ['node', 'node-addons'],
  },
  setupFilesAfterEnv: ['<rootDir>/test-setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@repo/auth/server$': '<rootDir>/../../../libs/auth/src/server/index.ts',
    '^@repo/auth/client$': '<rootDir>/../../../libs/auth/src/client/index.ts',
    '^@repo/(.*)$': '<rootDir>/../../../libs/$1/src',
  },
  reporters: process.env.IS_CI
    ? [
        ['github-actions', { silent: false }],
        ['default', {}],
      ]
    : // Hacky way to disable the summary output which corrupts terminals.
      [['default', { summaryThreshold: 1000 }]],
};

export default async () => {
  const config = await createJestConfig(customJestConfig)();
  config.transformIgnorePatterns = [
    `node_modules/(?!(.pnpm/(.+/node_modules/)?(${esmModules})|(${esmModules})))`,
  ];
  // next/jest mangles custom @repo mappings; rebuild the mapper on the final
  // config: next's own entries first, then the workspace preset's per-lib and
  // subpath mappings, with the @repo catch-all last so it can't shadow them.
  const { '^@repo/(.*)$': repoCatchAll, ...nextMapper } =
    config.moduleNameMapper ?? {};
  config.moduleNameMapper = {
    ...nextMapper,
    ...(workspacePreset.moduleNameMapper ?? {}),
    ...(repoCatchAll ? { '^@repo/(.*)$': repoCatchAll } : {}),
  };
  return config;
};
