import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: import.meta.dirname,
  projectName: '@agent-lcars/rerun-infra-killed-runs',
});
