#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { chromium } from '@playwright/test';

const PROFILE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  cpuSlowdown: 4,
  latencyMs: 150,
  downloadBytesPerSecond: (1.6 * 1_000_000) / 8,
  uploadBytesPerSecond: 750_000 / 8,
};
const TARGET_MS = 2_000;
const SAMPLE_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 15 * 60_000;
const ITEM_PATH = '/inbox?item=supersprinklesracing%2Fsprinkles%239003';

/** Reject unsafe destinations before launching Chromium or seeding anything. */
export function labOptions(args, env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      origin: { type: 'string' },
      samples: { type: 'string', default: '30' },
      out: { type: 'string' },
    },
  });
  const origin = new URL(values.origin ?? '');
  const emulator = new URL(`http://${env.FIRESTORE_EMULATOR_HOST ?? ''}`);
  const loopback = (host) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (
    origin.protocol !== 'http:' ||
    !loopback(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !loopback(emulator.hostname) ||
    env.E2E_HERMETIC !== '1' ||
    env.PROJECT_ID !== 'demo-no-project'
  ) {
    throw new Error(
      'Only explicit loopback demo-no-project hermetic labs are allowed.',
    );
  }
  const samples = Number(values.samples);
  if (!Number.isInteger(samples) || samples < 5 || samples > 60) {
    throw new Error('Samples must be an integer from 5 to 60 per cache case.');
  }
  if (!values.out)
    throw new Error('Provide --out for the measurement artifact.');
  return { origin: origin.origin, samples, out: path.resolve(values.out) };
}

const percentile = (values, quantile) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1];

async function seed(origin) {
  const response = await fetch(`${origin}/api/e2e/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'seed-inbox' }),
    signal: AbortSignal.timeout(SAMPLE_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Lab fixture seed failed: HTTP ${response.status}.`);
}

async function milestone(page, origin) {
  const response = await page.goto(`${origin}${ITEM_PATH}`, {
    waitUntil: 'load',
    timeout: SAMPLE_TIMEOUT_MS,
  });
  if (!response?.ok()) throw new Error('Inbox navigation failed.');
  if (new URL(page.url()).pathname !== '/inbox')
    throw new Error('Inbox redirected.');
  const detail = page.locator('.queue-workspace__detail');
  await detail
    .getByText('feat(console): tap-icon refresh on the queue header', {
      exact: true,
    })
    .waitFor();
  // This must invoke the real hydrated primary-action handler, not merely
  // observe server-rendered enabled markup. Never confirm a merge or dispatch.
  await detail
    .getByRole('button', { name: 'Approve & Rebase', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Rebase #9003?' });
  await dialog.waitFor();
  const measured = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    return {
      readyMs: performance.now(),
      responseStartMs: navigation.responseStart,
      responseEndMs: navigation.responseEnd,
      domInteractiveMs: navigation.domInteractive,
      resources: resources.map((entry) => ({
        path: new URL(entry.name).pathname,
        type: entry.initiatorType,
        durationMs: entry.duration,
        transferBytes: entry.transferSize,
        encodedBytes: entry.encodedBodySize,
      })),
    };
  });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  return measured;
}

export async function measure(options) {
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    environment: {
      host: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
    },
    profile: PROFILE,
    targetMs: TARGET_MS,
    milestone:
      'Direct phone Inbox decision deep link, document load, and hydrated primary-action confirmation visible; conservative upper bound, no confirmation submitted',
    fixture:
      'Existing populated GitHub/CLI/Work fixture plus two native parks (seed-inbox)',
    cacheCases: {
      cold: 'Fresh browser context, HTTP cache cleared and disabled; server already warm',
      warm: 'Fresh context, one untimed identical navigation/action, then timed reload with HTTP cache enabled; server already warm',
    },
    samplesPerCase: options.samples,
    quantile:
      'Nearest rank: sorted[ceil(0.95 * n) - 1]; cold and warm never pooled',
    samples: [],
  };
  let browser;
  let deadline;
  try {
    report.sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    browser = await chromium.launch({
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    report.browserVersion = browser.version();
    deadline = setTimeout(() => {
      report.error = 'Measurement exceeded its whole-run deadline';
      void browser.close().catch((error) => {
        report.cleanupError = error.message;
      });
    }, RUN_TIMEOUT_MS);
    await seed(options.origin);
    for (let index = 0; index < options.samples; index++) {
      // Interleave cases rather than assigning all cold runs the cold server.
      for (const cache of ['warm', 'cold']) {
        const context = await browser.newContext({
          viewport: PROFILE.viewport,
          deviceScaleFactor: PROFILE.deviceScaleFactor,
          isMobile: true,
          hasTouch: true,
          reducedMotion: 'reduce',
          serviceWorkers: 'block',
          extraHTTPHeaders: { 'X-e2e-auth-user': 'e2e-agent-lcars-admin' },
        });
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(SAMPLE_TIMEOUT_MS);
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          page.on('console', (message) => {
            if (message.type() === 'error') errors.push(message.text());
          });
          const cdp = await context.newCDPSession(page);
          await cdp.send('Network.enable');
          await cdp.send('Emulation.setCPUThrottlingRate', {
            rate: PROFILE.cpuSlowdown,
          });
          await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: PROFILE.latencyMs,
            downloadThroughput: PROFILE.downloadBytesPerSecond,
            uploadThroughput: PROFILE.uploadBytesPerSecond,
          });
          if (cache === 'cold') {
            await cdp.send('Network.clearBrowserCache');
            await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
          } else {
            await milestone(page, options.origin);
          }
          const sample = await milestone(page, options.origin);
          if (errors.length)
            throw new Error(`Browser errors: ${errors.join('; ')}`);
          report.samples.push({ cache, index: index + 1, ...sample });
          console.log(
            `${cache} ${index + 1}/${options.samples}: ${sample.readyMs.toFixed(0)}ms`,
          );
        } finally {
          await context.close();
        }
      }
    }
    report.summary = Object.fromEntries(
      ['cold', 'warm'].map((cache) => {
        const values = report.samples
          .filter((sample) => sample.cache === cache)
          .map((sample) => sample.readyMs);
        const p95Ms = percentile(values, 0.95);
        return [
          cache,
          {
            n: values.length,
            p50Ms: percentile(values, 0.5),
            p95Ms,
            maxMs: Math.max(...values),
            targetMet: p95Ms < TARGET_MS,
          },
        ];
      }),
    );
  } catch (error) {
    report.error =
      error instanceof Error ? error.message : 'Measurement failed';
  } finally {
    clearTimeout(deadline);
    try {
      await browser?.close();
    } catch (error) {
      report.cleanupError =
        error instanceof Error ? error.message : 'Browser cleanup failed';
      report.error ??= report.cleanupError;
    }
    if (report.error) delete report.summary;
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
    });
  }
  if (report.error) throw new Error(report.error);
  console.log(JSON.stringify(report.summary, null, 2));
  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await measure(labOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Measurement failed',
    );
    process.exitCode = 1;
  }
}
