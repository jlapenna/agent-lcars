import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: import.meta.dirname,
  projectName: '@agent-lcars/util',
  needsJestFnShim: true,
  overrides: {
    test: {
      setupFiles: ['./test-setup.ts'],
    },
  },
});
