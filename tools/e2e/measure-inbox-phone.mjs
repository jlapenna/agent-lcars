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

async function milestone(page, origin, active, phase) {
  // These checkpoints explain the existing journey; none relax its load
  // barrier or replace the real primary-action confirmation with markup.
  active.stage = `${phase}.document-load`;
  const response = await page.goto(`${origin}${ITEM_PATH}`, {
    waitUntil: 'load',
    timeout: SAMPLE_TIMEOUT_MS,
  });
  if (!response?.ok()) throw new Error('Inbox navigation failed.');
  if (new URL(page.url()).pathname !== '/inbox')
    throw new Error('Inbox redirected.');
  const documentLoadObservedMs = await page.evaluate(() => performance.now());
  active.stage = `${phase}.decision-content`;
  const detail = page.locator('.queue-workspace__detail');
  await detail
    .getByText('feat(console): tap-icon refresh on the queue header', {
      exact: true,
    })
    .waitFor();
  const clickRequestedMs = await page.evaluate(() => performance.now());
  active.stage = `${phase}.primary-action`;
  // This must invoke the real hydrated primary-action handler, not merely
  // observe server-rendered enabled markup. Never confirm a merge or dispatch.
  await detail
    .getByRole('button', { name: 'Approve & Rebase', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Rebase #9003?' });
  active.stage = `${phase}.confirmation`;
  await dialog.waitFor();
  const measured = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    const diagnostics = window.__inboxPhoneDiagnostics;
    diagnostics.collect(diagnostics.observer.takeRecords());
    return {
      readyMs: performance.now(),
      responseStartMs: navigation.responseStart,
      responseEndMs: navigation.responseEnd,
      domInteractiveMs: navigation.domInteractive,
      domContentLoadedMs: navigation.domContentLoadedEventEnd,
      loadEventMs: navigation.loadEventEnd,
      primaryClickDispatchedMs: diagnostics.clickMs,
      longTasks: diagnostics.longTasks,
      longTasksTruncated: diagnostics.longTasksTruncated,

      resources: resources.map((entry) => ({
        path: new URL(entry.name).pathname,
        type: entry.initiatorType,
        startMs: entry.startTime,
        responseStartMs: entry.responseStart,
        responseEndMs: entry.responseEnd,
        durationMs: entry.duration,
        transferBytes: entry.transferSize,
        encodedBytes: entry.encodedBodySize,
      })),
    };
  });
  if (!Number.isFinite(measured.primaryClickDispatchedMs))
    throw new Error('Primary click diagnostic was not captured.');
  active.stage = `${phase}.cancel`;
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  return { documentLoadObservedMs, clickRequestedMs, ...measured };
}

function diagnosticPath(value, origin) {
  if (value === 'about:blank') return value;
  try {
    const url = new URL(value);
    return url.origin === origin ? url.pathname.slice(0, 160) : '<external>';
  } catch {
    return '<unavailable>';
  }
}

async function failedPageObservation(page) {
  if (!page || page.isClosed())
    return { status: 'unavailable', reason: 'page-closed' };
  let timer;
  try {
    return await Promise.race([
      page
        .evaluate(() => {
          const navigation = performance.getEntriesByType('navigation')[0];
          return {
            status: 'observed',
            readyState: document.readyState,
            navigation: navigation
              ? {
                  responseStartMs: navigation.responseStart,
                  responseEndMs: navigation.responseEnd,
                  domInteractiveMs: navigation.domInteractive,
                  domContentLoadedMs: navigation.domContentLoadedEventEnd,
                  loadEventMs: navigation.loadEventEnd,
                }
              : null,
          };
        })
        .catch(() => ({
          status: 'unavailable',
          reason: 'page-observation-failed',
        })),
      new Promise((resolve) => {
        timer = setTimeout(
          () =>
            resolve({ status: 'unavailable', reason: 'observation-deadline' }),
          1_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function measure(options) {
  const report = {
    schemaVersion: 3,
    measuredAt: new Date().toISOString(),
    environment: {
      host: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model,
      systemObservationsAtStart: {
        loadAverage: os.loadavg(),
        freeMemoryBytes: os.freemem(),
      },
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
    diagnostics: {
      checkpoints:
        'Navigation-relative milliseconds; observation checkpoints include automation scheduling. The captured click is event dispatch, not an exact hydration timestamp.',
      longTasks:
        'PerformanceObserver longtask entries (>=50ms), navigation through confirmation observation, capped at 200; overlapping resource and task durations must not be added.',
      mainThread:
        'CDP Performance task/script/layout/style durations in milliseconds from collection enabled after warmup, or its restoration in the timed renderer. Current-renderer timeTicks counters include Cancel cleanup and metric-read scheduling; they exclude earlier warmup, are not cross-renderer totals, and are not a CPU profile or hydration-only measure.',
    },
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
        const active = { cache, index: index + 1, stage: 'page-setup' };
        const requests = new Map();
        const browserErrors = { page: 0, console: 0, crashed: false };
        let droppedRequests = 0;
        let page;
        const started = performance.now();
        const elapsedMs = () => Math.round(performance.now() - started);
        try {
          page = await context.newPage();
          page.setDefaultTimeout(SAMPLE_TIMEOUT_MS);
          page.on('request', (request) => {
            if (requests.size >= 64) {
              droppedRequests++;
              return;
            }
            requests.set(request, {
              path: diagnosticPath(request.url(), options.origin),
              type: request.resourceType(),
              method: request.method(),
              mainFrame:
                request.isNavigationRequest() &&
                request.frame() === page.mainFrame(),
              startedMs: elapsedMs(),
            });
          });
          page.on('response', (response) => {
            const record = requests.get(response.request());
            if (record)
              Object.assign(record, {
                status: response.status(),
                responseMs: elapsedMs(),
              });
          });
          page.on('requestfinished', (request) => {
            const record = requests.get(request);
            if (record) record.finishedMs = elapsedMs();
          });
          page.on('requestfailed', (request) => {
            const record = requests.get(request);
            if (record)
              Object.assign(record, {
                failedMs: elapsedMs(),
                failure:
                  /net::ERR_[A-Z_]+/u.exec(
                    request.failure()?.errorText ?? '',
                  )?.[0] ?? 'request-failed',
              });
          });
          page.on('crash', () => {
            browserErrors.crashed = true;
          });
          await page.addInitScript(() => {
            const diagnostics = {
              clickMs: null,
              longTasks: [],
              longTasksTruncated: false,
            };
            window.__inboxPhoneDiagnostics = diagnostics;
            diagnostics.collect = (entries) => {
              for (const entry of entries) {
                if (diagnostics.longTasks.length < 200)
                  diagnostics.longTasks.push({
                    startMs: entry.startTime,
                    durationMs: entry.duration,
                  });
                else diagnostics.longTasksTruncated = true;
              }
            };
            diagnostics.observer = new PerformanceObserver((list) =>
              diagnostics.collect(list.getEntries()),
            );
            diagnostics.observer.observe({ type: 'longtask', buffered: true });
            document.addEventListener(
              'click',
              (event) => {
                const button =
                  event.target instanceof Element
                    ? event.target.closest('button')
                    : null;
                if (
                  button?.textContent?.trim() === 'Approve & Rebase' &&
                  button.closest('.queue-workspace__detail')
                )
                  diagnostics.clickMs = performance.now();
              },
              { capture: true },
            );
          });
          const errors = [];
          page.on('pageerror', (error) => {
            browserErrors.page++;
            errors.push(error.message);
          });
          page.on('console', (message) => {
            if (message.type() === 'error') {
              browserErrors.console++;
              errors.push(message.text());
            }
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
            await milestone(page, options.origin, active, 'warmup');
          }
          // Start collection after the untimed warmup. Renderer restoration can
          // reset duration counters across navigation; never subtract an older
          // document's accumulated work from the timed renderer's counters.
          await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
          requests.clear();
          droppedRequests = 0;
          const sample = await milestone(page, options.origin, active, 'timed');
          active.stage = 'timed.metrics';
          const afterMetrics = await cdp.send('Performance.getMetrics');
          sample.mainThreadMs = Object.fromEntries(
            afterMetrics.metrics
              .filter(({ name }) =>
                [
                  'TaskDuration',
                  'V8CompileDuration',
                  'DevToolsCommandDuration',
                  'ScriptDuration',
                  'LayoutDuration',
                  'RecalcStyleDuration',
                ].includes(name),
              )
              .map(({ name, value }) => [name, value * 1_000]),
          );
          if (errors.length)
            throw new Error(`Browser errors: ${errors.join('; ')}`);
          report.samples.push({ cache, index: index + 1, ...sample });
          console.log(
            `${cache} ${index + 1}/${options.samples}: ${sample.readyMs.toFixed(0)}ms`,
          );
        } catch (error) {
          // Collect while the failing renderer still exists. Queries, origins,
          // credentials, headers, bodies and arbitrary console text stay out.
          const observation = await failedPageObservation(page);
          report.failureDiagnostics = {
            ...active,
            elapsedMs: elapsedMs(),
            mainFramePath: page
              ? diagnosticPath(page.url(), options.origin)
              : '<unavailable>',
            browserConnected: browser.isConnected(),
            browserErrors,
            requests: [...requests.values()],
            droppedRequests,
            observation,
          };
          throw error;
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
    report.environment.systemObservationsAtEnd = {
      loadAverage: os.loadavg(),
      freeMemoryBytes: os.freemem(),
    };
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
