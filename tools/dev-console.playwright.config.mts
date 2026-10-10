import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

if (!process.env.LCARS_DEV_TEST_OUTPUT || !process.env.BASE_URL) {
  throw new Error(
    'Use pnpm dev:test to select and validate a running local stack.',
  );
}

// Reuse the production journey specs while leaving the existing dev server,
// hot reload, and emulators running. CI continues to use its standalone bundle.
export default defineConfig({
  testDir: path.resolve(import.meta.dirname, '../apps/console-e2e/src'),
  outputDir: path.join(process.env.LCARS_DEV_TEST_OUTPUT, 'results'),
  timeout: 90_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
  },
});
