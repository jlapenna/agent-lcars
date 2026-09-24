// Explicit release qualification, not a default unit-test lane: requires the
// reports produced by image-bound native exhaustion scenarios.
import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: import.meta.dirname,
  projectName: 'native-failure-qualification',
  overrides: {
    test: { include: ['native-failure-qualification.ts'], testTimeout: 30000 },
  },
});
