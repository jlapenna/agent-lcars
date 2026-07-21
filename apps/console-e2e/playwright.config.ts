import { workspaceRoot } from '@nx/devkit';
import { nxE2EPreset } from '@nx/playwright/preset';
import { defineConfig, devices } from '@playwright/test';
import * as fs from 'fs';

/**
 * See https://playwright.dev/docs/test-configuration.
 */
const baseURL = process.env['BASE_URL'] || 'http://127.0.0.1:4200';

if (!process.env.CI && !fs.existsSync('/.dockerenv')) {
  process.env.SKIP_VISUAL = '1';
}

const envChromium = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
const executablePath =
  envChromium && fs.existsSync(envChromium) ? envChromium : undefined;

export default defineConfig({
  ...nxE2EPreset(__filename, { testDir: './src' }),
  timeout: 300000,
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
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    contextOptions: {
      reducedMotion: 'reduce',
    },
    launchOptions: {
      executablePath,
    },
  },
  // No @visual specs in this suite yet, but keep the same knobs as the other
  // three apps' configs so tools/e2e-docker.sh's SKIP_VISUAL/E2E_GREP/
  // VISUAL_ONLY forwarding behaves identically here.
  ...(process.env.SKIP_VISUAL === '1'
    ? { grepInvert: /@visual/, ignoreSnapshots: true }
    : {}),
  ...(process.env.VISUAL_ONLY === '1' ? { grep: /@visual/ } : {}),
  ...(process.env.E2E_GREP ? { grep: new RegExp(process.env.E2E_GREP) } : {}),
  // Serve the prebuilt standalone bundle directly rather than via `nx run
  // serve-e2e` — invoking nx here re-enters the running task graph
  // ("Recursive task invocation detected"), same gotcha documented in the
  // other three apps' configs. The `e2e` target's `dependsOn` builds and
  // bundles the standalone server up-front.
  webServer: {
    command:
      'pnpm exec dotenv -e .env.e2e -e .env.e2e.local --optional -- node dist/apps/console/.next/standalone/apps/console/server.js',
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
