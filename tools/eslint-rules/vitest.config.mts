import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: __dirname,
  projectName: 'eslint-rules',
  overrides: {
    test: {
      include: ['rules/**/*.spec.ts'],
    },
  },
});
