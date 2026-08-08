import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: import.meta.dirname,
  projectName: '@agent-lcars/app-providers',
  environment: 'jsdom',
  needsJestDomMatchers: true,
  needsMatchMediaMock: true,
});
