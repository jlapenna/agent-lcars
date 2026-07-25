import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: __dirname,
  projectName: '@agent-lcars/telemetry-watcher',
  needsFirestoreMockShim: true,
});
