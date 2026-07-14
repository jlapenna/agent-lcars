import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: __dirname,
  projectName: '@repo/auth',
  environment: 'jsdom',
  needsFirestoreMockShim: true,
});
