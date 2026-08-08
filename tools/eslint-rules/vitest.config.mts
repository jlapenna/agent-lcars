import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: import.meta.dirname,
  projectName: 'eslint-rules',
  overrides: {
    test: {
      include: ['rules/**/*.spec.ts'],
    },
  },
});
