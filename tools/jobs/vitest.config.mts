import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: import.meta.dirname,
  projectName: 'repository-jobs',
  overrides: { test: { maxWorkers: 1, passWithNoTests: false } },
});
