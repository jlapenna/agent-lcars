#!/usr/bin/env node

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUIDANCE =
  'Local E2E is optional. Push ready source and use the required CI E2E lane. ' +
  'Use a prepared host or the published pinned E2E sandbox (docs/e2e-reliability.md). ' +
  'Do not install system packages or weaken worker privileges.';

// A cold first launch of a freshly provisioned runner can exceed a few seconds
// (the same-head recovery of the #2553 failure launched in under one second).
// The bound stays finite and below the whole-phase deadline.
export const LAUNCH_TIMEOUT_MS = 30000;
const PHASE_DEADLINE_MS = 45000;

// Never print Playwright's raw launch log: it can contain arbitrary executable
// output or paths. Retain only a bounded dependency name or a fixed category.
export function browserFailureReason(error) {
  const message = String(error?.message ?? '');
  const library = message.match(
    /\b(lib[A-Za-z0-9_+.-]{1,80}\.so(?:\.[0-9]+)*)\b[^\n]{0,80}(?:cannot open shared object|not found)/u,
  );
  if (library) return `missing shared library ${library[1]}`;
  if (/Executable doesn't exist|executable doesn't exist/iu.test(message)) {
    return 'matching Chromium executable is unavailable';
  }
  if (/Timeout|timed out/iu.test(message)) return 'Chromium launch timed out';
  return 'Chromium could not launch or close';
}

export async function checkBrowser(chromium, executablePath) {
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    timeout: LAUNCH_TIMEOUT_MS,
  });
  try {
    return browser.version();
  } finally {
    await browser.close();
  }
}

async function main() {
  // Bound the entire discovery/launch/close phase, including module loading.
  const deadline = setTimeout(() => {
    console.error(`e2e-browser: prerequisite check timed out. ${GUIDANCE}`);
    process.exit(1);
  }, PHASE_DEADLINE_MS);
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const require = createRequire(import.meta.url);
    const testRequire = createRequire(
      require.resolve('@playwright/test/package.json'),
    );
    const playwrightRequire = createRequire(
      testRequire.resolve('playwright/package.json'),
    );
    const coreRoot = path.dirname(
      playwrightRequire.resolve('playwright-core/package.json'),
    );
    const { version } = testRequire('@playwright/test/package.json');
    const { browsers } = JSON.parse(
      fs.readFileSync(path.join(coreRoot, 'browsers.json'), 'utf8'),
    );
    const expected = browsers.find((browser) => browser.name === 'chromium');
    console.log(
      `e2e-browser: Playwright ${version}; expected Chromium ${expected.browserVersion} (revision ${expected.revision})`,
    );
    const { chromium } = testRequire('@playwright/test');
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    if (executablePath && !fs.existsSync(executablePath)) {
      console.error(
        `e2e-browser: configured Chromium executable is unavailable. ${GUIDANCE}`,
      );
      process.exitCode = 1;
      return;
    }
    const discoveredMs = elapsed();
    const actual = await checkBrowser(chromium, executablePath);
    console.log(
      `e2e-browser: launched Chromium ${actual}; prerequisites ready (discovery ${discoveredMs}ms, launch+close ${elapsed() - discoveredMs}ms)`,
    );
  } catch (error) {
    const reason =
      error?.code === 'MODULE_NOT_FOUND' ||
      error?.code === 'ERR_MODULE_NOT_FOUND'
        ? 'workspace Playwright dependency is unavailable; run the normal worktree setup'
        : browserFailureReason(error);
    console.error(`e2e-browser: ${reason} after ${elapsed()}ms. ${GUIDANCE}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
