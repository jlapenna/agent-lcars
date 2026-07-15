import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: __dirname,
  projectName: '@repo/util',
  needsJestFnShim: true,
  overrides: {
    test: {
      setupFiles: ['./test-setup.ts'],
    },
  },
});
