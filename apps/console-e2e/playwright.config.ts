import { workspaceRoot } from '@nx/devkit';
import { nxE2EPreset } from '@nx/playwright/preset';
import { defineConfig, devices } from '@playwright/test';
import * as fs from 'fs';

/**
 * See https://playwright.dev/docs/test-configuration.
 */
const baseURL = process.env['BASE_URL'] || 'http://127.0.0.1:4200';

const envChromium = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
const executablePath =
  envChromium && fs.existsSync(envChromium) ? envChromium : undefined;

export default defineConfig({
  ...nxE2EPreset(__filename, { testDir: './src' }),
  // Nx retries a failed test twice in CI. A five-minute per-test ceiling
  // therefore lets one missed event/action consume 15 minutes of this
  // serial job before the remaining specs can run (#519). The slowest real
  // production-bundle case is normally under 15 seconds; 90 seconds keeps
  // substantial saturation headroom while bounding one broken test to 4.5
  // minutes across all three CI attempts. Exceptionally long scenarios
  // must opt in with test.setTimeout() and explain their own bound.
  timeout: 90_000,
  workers: 1,
  outputDir: './test-output/test-results',
  reporter: [
    [
      'html',
      { outputFolder: './test-output/playwright-report', open: 'never' },
    ],
    process.env.CI ? ['github'] : ['list'],
  ],
  use: {
    baseURL,
    trace: 'on-first-retry',
    // Captures are diagnostics, never pass/fail goldens. Pixel equality made
    // intentional styling changes fail and let real-time labels turn unrelated
    // commits red (#1049); retain the useful failure evidence without making
    // rendered bytes part of the test contract.
    screenshot: 'only-on-failure',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    contextOptions: {
      reducedMotion: 'reduce',
    },
    launchOptions: {
      executablePath,
    },
  },
  ...(process.env.E2E_GREP ? { grep: new RegExp(process.env.E2E_GREP) } : {}),
  // Serve the prebuilt standalone bundle directly rather than via `nx run
  // serve-e2e` — invoking nx here re-enters the running task graph
  // ("Recursive task invocation detected"). The `e2e` target's `dependsOn`
  // builds and bundles the standalone server up-front.
  webServer: {
    command:
      'pnpm exec dotenv -e "${E2E_ENV_FILE:-.env.e2e}" -e "${E2E_ENV_LOCAL_FILE:-.env.e2e.local}" --optional -- node dist/apps/console/.next/standalone/apps/console/server.js',
    env: {
      PORT: '4200',
      HOSTNAME: '127.0.0.1',
      NODE_OPTIONS: '--max-old-space-size=8192',
      AUTH_URL: 'http://localhost:4200',
      E2E_TESTING: 'true',
      AGENT_CONSOLE_GITHUB_API_BASE_URL: 'http://localhost:4200/api/e2e/github',
    },
    url: 'http://127.0.0.1:4200',
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120000,
    cwd: workspaceRoot,
  },
  projects: [
    {
      name: 'chrome-desktop',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { executablePath },
      },
    },
  ],
});
