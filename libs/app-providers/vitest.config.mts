import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: __dirname,
  projectName: '@repo/app-providers',
  environment: 'jsdom',
  needsJestDomMatchers: true,
  needsMatchMediaMock: true,
});
