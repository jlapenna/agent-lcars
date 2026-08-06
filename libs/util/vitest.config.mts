import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: __dirname,
  projectName: '@agent-lcars/util',
  needsJestFnShim: true,
  overrides: {
    test: {
      setupFiles: ['./test-setup.ts'],
    },
  },
});
