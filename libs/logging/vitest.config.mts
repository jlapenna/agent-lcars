import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: __dirname,
  projectName: '@agent-lcars/logging',
  overrides: {
    test: {
      setupFiles: ['./test-setup.ts'],
    },
  },
});
