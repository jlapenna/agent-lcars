import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: import.meta.dirname,
  projectName: '@agent-lcars/logging',
  overrides: {
    test: {
      setupFiles: ['./test-setup.ts'],
    },
  },
});
