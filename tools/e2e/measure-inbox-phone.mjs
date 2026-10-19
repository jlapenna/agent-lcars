#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { connect, createServer, isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { chromium } from '@playwright/test';

import { checkNetworkBoundary } from './check-network.mjs';

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
const BUILD_EVIDENCE_FILES = [
  'BUILD_ID',
  'server/app/inbox/page_client-reference-manifest.js',
  'server/app/inbox/page/build-manifest.json',
];

/** Reject unsafe destinations before launching Chromium or seeding anything. */
export function labOptions(args, env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      origin: { type: 'string' },
      samples: { type: 'string', default: '30' },
      out: { type: 'string' },
      'cpu-profile-out': { type: 'string' },
      'transport-experiment': { type: 'boolean', default: false },
      'tls-diagnostic': { type: 'boolean', default: false },
      'tls-certificate': { type: 'string' },
    },
  });
  const origin = new URL(values.origin ?? '');
  const emulator = new URL(`http://${env.FIRESTORE_EMULATOR_HOST ?? ''}`);
  const loopback = (host) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    !loopback(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !loopback(emulator.hostname) ||
    emulator.username ||
    emulator.password ||
    emulator.pathname !== '/' ||
    emulator.search ||
    emulator.hash ||
    !emulator.port ||
    env.E2E_HERMETIC !== '1' ||
    env.PROJECT_ID !== 'demo-no-project'
  ) {
    throw new Error(
      'Only explicit loopback demo-no-project hermetic labs are allowed.',
    );
  }
  const tlsEnabled = values['tls-diagnostic'];
  const certificate = values['tls-certificate'];
  if (
    (origin.protocol === 'https:') !== tlsEnabled ||
    tlsEnabled !== Boolean(certificate) ||
    (tlsEnabled && values['cpu-profile-out']) ||
    (values['transport-experiment'] &&
      (tlsEnabled || values['cpu-profile-out']))
  )
    throw Error(
      'TLS requires HTTPS, --tls-diagnostic and --tls-certificate together; no CPU profile.',
    );
  if (
    (tlsEnabled || values['transport-experiment']) &&
    (env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      (env.AUTH_SECRET !== undefined && env.AUTH_SECRET !== 'dummy-secret') ||
      env.E2E_TESTING === 'false')
  )
    throw Error(
      'TLS diagnostic requires ordinary verified TLS and dummy hermetic auth.',
    );
  const tls = tlsEnabled
    ? tlsCertificate(certificate, origin.hostname)
    : undefined;
  const samples = Number(values.samples);
  if (!Number.isInteger(samples) || samples < 5 || samples > 60) {
    throw new Error('Samples must be an integer from 5 to 60 per cache case.');
  }
  if (!values.out)
    throw new Error('Provide --out for the measurement artifact.');
  return {
    origin: origin.origin,
    samples,
    out: path.resolve(values.out),
    cpuProfileOut: values['cpu-profile-out']
      ? path.resolve(values['cpu-profile-out'])
      : undefined,
    ...(tls ? { tls } : {}),
    ...(values['transport-experiment'] ? { experiment: true } : {}),
  };
}

/** Public certificate only; the measurement process never receives a private key. */
export function tlsCertificate(file, hostname) {
  const resolved = realpathSync(file);
  const relative = path.relative(realpathSync(os.tmpdir()), resolved);
  const parent = statSync(path.dirname(resolved));
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !statSync(resolved).isFile() ||
    statSync(resolved).size > 16_384 ||
    path.dirname(resolved) === realpathSync(os.tmpdir()) ||
    (parent.mode & 0o077) !== 0 ||
    (process.getuid && parent.uid !== process.getuid())
  )
    throw Error('TLS certificate must be a bounded task-local temporary file.');
  const pem = readFileSync(resolved, 'utf8');
  if (
    !/^\s*-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(
      pem,
    ) ||
    /PRIVATE KEY/.test(pem) ||
    (pem.match(/BEGIN CERTIFICATE/g) ?? []).length !== 1
  )
    throw Error('Provide exactly one public certificate.');
  const cert = new X509Certificate(pem);
  const host = hostname.replace(/^\[|\]$/g, '');
  if (
    !cert.checkIssued(cert) ||
    !cert.verify(cert.publicKey) ||
    !(isIP(host) ? cert.checkIP(host) : cert.checkHost(host)) ||
    Date.parse(cert.validFrom) > Date.now() ||
    Date.parse(cert.validTo) <= Date.now()
  )
    throw Error(
      'TLS diagnostic requires a valid self-signed certificate for the loopback host.',
    );
  return {
    ca: pem,
    certificateSHA256: createHash('sha256').update(cert.raw).digest('hex'),
    spkiSHA256: createHash('sha256')
      .update(cert.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64'),
  };
}

export function tlsLaunchOptions(tls) {
  return tls
    ? { args: [`--ignore-certificate-errors-spki-list=${tls.spkiSHA256}`] }
    : {};
}

const staticJS = /^\/_next\/static\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.js$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Retain only bounded response metadata, never request headers or dynamic bodies. */
export function transportResponse(response, origin, type) {
  const url = new URL(response.url);
  if (
    url.origin !== origin ||
    url.hash ||
    !(
      (url.pathname === '/inbox' && type === 'Document') ||
      (!url.search && staticJS.test(url.pathname))
    )
  )
    return undefined;
  const headers = {};
  for (const [key, value] of Object.entries(response.headers)) {
    const name = key.toLowerCase();
    if (
      [
        'content-encoding',
        'vary',
        'content-length',
        'cache-control',
        'etag',
        'age',
      ].includes(name)
    )
      headers[name] = String(value).slice(0, 256);
  }
  return {
    path: url.pathname,
    type,
    protocol: response.protocol,
    status: response.status,
    encoding: headers['content-encoding'] ?? 'identity',
    headers,
  };
}

export async function transportBuildHashes(next = 'dist/apps/console/.next') {
  return Object.fromEntries(
    await Promise.all(
      BUILD_EVIDENCE_FILES.map(async (file) => [
        file,
        sha256(await readFile(path.join(next, file))),
      ]),
    ),
  );
}

export function transportSummary(blocks) {
  if (
    blocks.length !== 4 ||
    blocks.map((b) => b.arm).join(',') !== 'h1,h2,h2,h1'
  )
    throw Error('Incomplete counterbalanced transport blocks');
  const first = blocks[0].report;
  let corpus;
  let encodings;
  for (const { arm, report } of blocks) {
    if (
      report.error ||
      report.samples.length !== 30 ||
      !report.transport ||
      report.browserVersion !== first.browserVersion ||
      report.sourceRevision !== first.sourceRevision ||
      JSON.stringify(report.profile) !== JSON.stringify(first.profile) ||
      JSON.stringify(report.transport) !== JSON.stringify(first.transport)
    )
      throw Error('Confounded or incomplete transport cohort');
    for (const cache of ['cold', 'warm'])
      if (report.samples.filter((s) => s.cache === cache).length !== 15)
        throw Error('Incomplete cache block');
    for (const sample of report.samples.filter((s) => s.cache === 'cold')) {
      const expected = arm === 'h1' ? 'http/1.1' : 'h2';
      const scripts = sample.resources.filter((r) => staticJS.test(r.path));
      const metadata = sample.transportResponses;
      if (
        sample.nextHopProtocol !== expected ||
        !scripts.length ||
        scripts.some((r) => r.nextHopProtocol !== expected) ||
        !metadata?.some((r) => r.path === '/inbox' && r.type === 'Document') ||
        metadata.some(
          (r) =>
            r.protocol !== expected ||
            r.status !== 200 ||
            !['gzip', 'identity'].includes(
              r.headers['content-encoding'] ?? 'identity',
            ),
        ) ||
        !metadata.some(
          (r) =>
            staticJS.test(r.path) && r.headers['content-encoding'] === 'gzip',
        )
      )
        throw Error('Confounded transport protocol or compression');
      if (
        metadata.filter((r) => staticJS.test(r.path)).length !==
          scripts.length ||
        !sample.scriptCorpus?.length ||
        sample.scriptCorpus.length !== scripts.length
      )
        throw Error('Incomplete static corpus');
      const encodingSignature = JSON.stringify(
        metadata
          .map((r) => ({
            path: r.path,
            encoding: r.headers['content-encoding'] ?? 'identity',
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      );
      encodings ??= encodingSignature;
      if (encodings !== encodingSignature)
        throw Error('Confounded per-path content encoding');
      for (const entry of sample.scriptCorpus) {
        const response = metadata.find((r) => r.path === entry.path);
        if (
          !response ||
          !Number.isFinite(entry.encodedBytes) ||
          entry.encodedBytes <= 0 ||
          !Number.isFinite(entry.decodedBytes) ||
          entry.decodedBytes <= 0 ||
          ((response.headers['content-encoding'] ?? 'identity') ===
            'identity' &&
            entry.encodedBytes !== entry.decodedBytes)
        )
          throw Error('Incomplete static byte/encoding evidence');
      }
      const signature = JSON.stringify(sample.scriptCorpus);
      corpus ??= signature;
      if (corpus !== signature) throw Error('Confounded static bytes or build');
    }
  }
  return Object.fromEntries(
    ['h1', 'h2'].map((arm) => [
      arm,
      Object.fromEntries(
        ['cold', 'warm'].map((cache) => {
          const values = blocks
            .filter((b) => b.arm === arm)
            .flatMap((b) =>
              b.report.samples
                .filter((s) => s.cache === cache)
                .map((s) => s.readyMs),
            );
          if (
            values.length !== 30 ||
            values.some((v) => !Number.isFinite(v) || v <= 0)
          )
            throw Error('Incomplete readiness cohort');
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
      ),
    ]),
  );
}

const percentile = (values, quantile) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1];

export async function seed(origin, tls) {
  if (tls) {
    await new Promise((resolve, reject) => {
      const request = httpsRequest(
        `${origin}/api/e2e/seed`,
        {
          method: 'POST',
          ca: tls.ca,
          rejectUnauthorized: true,
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(SAMPLE_TIMEOUT_MS),
        },
        (response) => {
          response.resume();
          response.on('end', () =>
            response.statusCode === 200
              ? resolve()
              : reject(
                  Error(
                    `Lab fixture seed failed: HTTP ${response.statusCode}.`,
                  ),
                ),
          );
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify({ action: 'seed-inbox' }));
    });
    return;
  }
  const response = await fetch(`${origin}/api/e2e/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'seed-inbox' }),
    signal: AbortSignal.timeout(SAMPLE_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Lab fixture seed failed: HTTP ${response.status}.`);
}

async function milestone(
  page,
  origin,
  active,
  phase,
  navigationBarrier = 'load',
) {
  // These checkpoints explain the existing journey; none relax its load
  // barrier or replace the real primary-action confirmation with markup.
  active.stage = `${phase}.document-load`;
  const response = await page.goto(`${origin}${ITEM_PATH}`, {
    waitUntil: navigationBarrier,
    timeout: SAMPLE_TIMEOUT_MS,
  });
  if (!response?.ok()) throw new Error('Inbox navigation failed.');
  if (new URL(page.url()).pathname !== '/inbox')
    throw new Error('Inbox redirected.');
  active.recordCheckpoint?.('navigation-returned');
  const documentLoadObservedMs = await page.evaluate(() => performance.now());
  active.stage = `${phase}.decision-content`;
  const detail = page.locator('.queue-workspace__detail');
  await detail
    .getByText('feat(console): tap-icon refresh on the queue header', {
      exact: true,
    })
    .waitFor();
  active.recordCheckpoint?.('decision-content-visible');
  const clickRequestedMs = await page.evaluate(() => performance.now());
  active.stage = `${phase}.primary-action`;
  // This must invoke the real hydrated primary-action handler, not merely
  // observe server-rendered enabled markup. Never confirm a merge or dispatch.
  await detail
    .getByRole('button', { name: 'Approve & Rebase', exact: true })
    .click();
  active.recordCheckpoint?.('primary-click-returned');
  const dialog = page.getByRole('dialog', { name: 'Rebase #9003?' });
  active.stage = `${phase}.confirmation`;
  await dialog.waitFor();
  active.recordCheckpoint?.('confirmation-visible');
  const measured = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    const diagnostics = window.__inboxPhoneDiagnostics;
    diagnostics.collect(diagnostics.observer.takeRecords());
    return {
      readyMs: performance.now(),
      responseStartMs: navigation.responseStart,
      responseEndMs: navigation.responseEnd,
      fetchStartMs: navigation.fetchStart,
      connectStartMs: navigation.connectStart,
      secureConnectionStartMs: navigation.secureConnectionStart,
      connectEndMs: navigation.connectEnd,
      requestStartMs: navigation.requestStart,
      nextHopProtocol: navigation.nextHopProtocol,
      documentTransferBytes: navigation.transferSize,
      documentEncodedBytes: navigation.encodedBodySize,
      documentDecodedBytes: navigation.decodedBodySize,
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
        fetchStartMs: entry.fetchStart,
        connectStartMs: entry.connectStart,
        secureConnectionStartMs: entry.secureConnectionStart,
        connectEndMs: entry.connectEnd,
        requestStartMs: entry.requestStart,
        nextHopProtocol: entry.nextHopProtocol,
        responseStartMs: entry.responseStart,
        responseEndMs: entry.responseEnd,
        durationMs: entry.duration,
        transferBytes: entry.transferSize,
        encodedBytes: entry.encodedBodySize,
        decodedBytes: entry.decodedBodySize,
      })),
    };
  });
  if (!Number.isFinite(measured.primaryClickDispatchedMs))
    throw new Error('Primary click diagnostic was not captured.');
  active.stage = `${phase}.cancel`;
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  active.recordCheckpoint?.('cancel-returned');
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

const installPageDiagnostics = () => {
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
        event.target instanceof Element ? event.target.closest('button') : null;
      if (
        button?.textContent?.trim() === 'Approve & Rebase' &&
        button.closest('.queue-workspace__detail')
      )
        diagnostics.clickMs = performance.now();
    },
    { capture: true },
  );
};

// One extra diagnostic journey AFTER the untouched budget samples. Debugger/
// Profiler overhead makes this unsuitable for p95. Only generated public chunk
// code and selected private build manifests are retained; never headers,
// application response bodies, storage, cookies, arbitrary URLs or source-map contents.
// Only extra excluded contexts install this bounded timestamp recorder.
const installInputBoundaryDiagnostics = () => {
  const diagnostic = window.__inboxPhoneDiagnostics;
  const allowed = new Set([
    'primaryCommitMs',
    'handlerEntryMs',
    'openConfirmReturnMs',
  ]);
  diagnostic.inputBoundaries = {};
  diagnostic.recordPrimaryBoundary = (name) => {
    if (allowed.has(name) && diagnostic.inputBoundaries[name] === undefined)
      diagnostic.inputBoundaries[name] = performance.now();
  };
  const observer = new MutationObserver(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(
      (node) =>
        node.getAttribute('aria-label') === 'Rebase #9003?' ||
        node.textContent?.includes('Rebase #9003?'),
    );
    if (!dialog) return;
    diagnostic.inputBoundaries.dialogInsertionObservedMs = performance.now();
    observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
};

async function captureColdProfile(
  browser,
  options,
  report,
  runDeadlineAt,
  navigationBarrier = 'load',
) {
  const maxBytes = 8 * 1024 * 1024;
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const artifact = {
    schemaVersion: 1,
    status: 'incomplete',
    excludedFromBudget: true,
    navigationBarrier,
    scope:
      'one extra cold navigation through real confirmation and Cancel; profiler/marker overhead, not an earliest-readiness or p95 claim',
    sourceRevision: report.sourceRevision,
    browserVersion: report.browserVersion,
    environment: report.environment,
    profile: PROFILE,
    sources: [],
    manifests: [],
  };
  let context;
  let page;
  let stage = 'setup';
  const attemptStartedAtMs = Date.now();
  const deadlineAt = Math.min(
    runDeadlineAt,
    attemptStartedAtMs + SAMPLE_TIMEOUT_MS,
  );
  artifact.attemptStartedAtMs = attemptStartedAtMs;
  artifact.deadlineAtMs = deadlineAt;
  const progress = {
    stage: 'not-started',
    completedCheckpoints: [],
    recordCheckpoint(name) {
      const completedAtMs = Date.now();
      if (completedAtMs < deadlineAt && this.completedCheckpoints.length < 5)
        this.completedCheckpoints.push({ name, completedAtMs });
    },
  };
  const retainProgress = (key = 'milestoneProgress') => {
    if (key === 'deadlineMilestoneProgress' && artifact[key]) return;
    artifact[key] = {
      stage: progress.stage,
      completedCheckpoints: [...progress.completedCheckpoints],
    };
  };
  let snapshotOpen = true;
  const partialSnapshot = async () => {
    if (
      !snapshotOpen ||
      artifact.status === 'complete' ||
      Date.now() >= deadlineAt
    )
      return;
    const observation = {
      status: 'pending',
      requestedAtMs: Date.now(),
      milestoneStage: progress.stage,
    };
    artifact.partialObservation = observation;
    if (!page) {
      observation.status = 'unavailable';
      observation.reason = 'page-not-created';
      return;
    }
    try {
      const value = await page.evaluate(() => {
        const diagnostic = window.__inboxPhoneDiagnostics;
        const navigation = performance.getEntriesByType('navigation')[0];
        const marks = {};
        for (const name of [
          'primaryCommitMs',
          'handlerEntryMs',
          'openConfirmReturnMs',
          'dialogInsertionObservedMs',
        ]) {
          const value = diagnostic?.inputBoundaries?.[name];
          if (Number.isFinite(value) && value >= 0) marks[name] = value;
        }
        const primary = document.querySelector(
          '.queue-workspace__detail .queue-primary-action',
        );
        return {
          nowMs: performance.now(),
          readyState: document.readyState,
          marks,
          capturedClickMs: Number.isFinite(diagnostic?.clickMs)
            ? diagnostic.clickMs
            : null,
          primaryPresent: Boolean(primary),
          primaryDisabled: primary?.disabled ?? null,
          matchingDialogPresent: [
            ...document.querySelectorAll('[role="dialog"]'),
          ].some(
            (node) =>
              node.getAttribute('aria-label') === 'Rebase #9003?' ||
              node.textContent?.includes('Rebase #9003?'),
          ),
          navigation: navigation
            ? {
                domContentLoadedMs: navigation.domContentLoadedEventEnd,
                loadEventMs: navigation.loadEventEnd,
              }
            : null,
        };
      });
      const completedAtMs = Date.now();
      if (snapshotOpen && completedAtMs < deadlineAt) {
        observation.status = 'observed';
        observation.completedAtMs = completedAtMs;
        observation.value = value;
      }
    } catch {
      if (snapshotOpen) {
        observation.status = 'unavailable';
        observation.reason = 'page-observation-failed';
      }
    }
  };
  // ONE best-effort read before the original hard close, never an added wait.
  const snapshotTimer = setTimeout(
    () => {
      void partialSnapshot();
    },
    Math.max(0, deadlineAt - Date.now() - 500),
  );
  let expired = false;
  const assertDeadline = () => {
    if (expired || Date.now() >= deadlineAt) {
      expired = true;
      retainProgress('deadlineMilestoneProgress');
      stage = 'diagnostic-deadline';
      throw Error('Diagnostic deadline exceeded');
    }
  };
  const timer = setTimeout(
    () => {
      expired = true;
      retainProgress('deadlineMilestoneProgress');
      snapshotOpen = false;
      if (
        !artifact.partialObservation ||
        artifact.partialObservation.status === 'pending'
      )
        artifact.partialObservation = {
          ...artifact.partialObservation,
          status: 'unavailable',
          reason: 'snapshot-not-completed-before-close',
          milestoneStage: progress.stage,
        };
      void context?.close().catch(() => undefined);
    },
    Math.max(0, deadlineAt - Date.now()),
  );
  try {
    stage = 'source-binding';
    artifact.sourceBindings = {};
    for (const file of [
      'tools/e2e/measure-inbox-phone.mjs',
      'apps/console/src/app/action-item-card.tsx',
      'apps/console-e2e/src/inbox-phone-lab.spec.ts',
      'apps/console/next.config.js',
      'pnpm-lock.yaml',
    ])
      artifact.sourceBindings[file] = sha(await readFile(file));
    assertDeadline();
    stage = 'setup';
    context = await browser.newContext({
      viewport: PROFILE.viewport,
      deviceScaleFactor: PROFILE.deviceScaleFactor,
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
      extraHTTPHeaders: { 'X-e2e-auth-user': 'e2e-agent-lcars-admin' },
    });
    assertDeadline();
    page = await context.newPage();
    page.setDefaultTimeout(SAMPLE_TIMEOUT_MS);
    // One init script guarantees recorder order before any application code.
    await page.addInitScript({
      content: `(${installPageDiagnostics.toString()})();(${installInputBoundaryDiagnostics.toString()})();`,
    });
    const cdp = await context.newCDPSession(page);
    const scripts = new Map();
    cdp.on('Debugger.scriptParsed', ({ scriptId, url, hash, length }) => {
      try {
        const parsed = new URL(url);
        if (
          parsed.origin === options.origin &&
          !parsed.search &&
          !parsed.hash &&
          /^\/_next\/static\/chunks\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js$/.test(
            parsed.pathname,
          )
        ) {
          scripts.set(scriptId, {
            scriptId,
            path: parsed.pathname,
            cdpHash: hash,
            length,
          });
        }
      } catch {
        /* Ignore inline, extension and non-static scripts. */
      }
    });
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
    await cdp.send('Network.clearBrowserCache');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Debugger.enable', { maxScriptsCacheSize: maxBytes });
    // Retain a same-session monotonic bridge only for this extra diagnostic.
    // Durations from the separate budget contexts cannot anchor this profile.
    await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
    const readClock = async () => {
      try {
        const { metrics } = await cdp.send('Performance.getMetrics');
        const values = {};
        for (const name of ['Timestamp', 'NavigationStart']) {
          const matches = metrics.filter((metric) => metric.name === name);
          if (
            matches.length === 1 &&
            Number.isFinite(matches[0].value) &&
            matches[0].value > 0
          )
            values[name] = matches[0].value;
        }
        return values;
      } catch {
        return {};
      }
    };
    artifact.clockBridge = {
      status: 'unavailable',
      timeDomain: 'timeTicks',
      metricUnits: 'seconds',
      profileUnits: 'microseconds',
      navigationUnits: 'milliseconds',
      sourceRevision: report.sourceRevision,
      browserVersion: report.browserVersion,
      checkpoints: {},
    };
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1_000 });
    stage = 'profiled-cold';
    artifact.clockBridge.checkpoints.beforeProfile = await readClock();
    artifact.profileStartedWallTimeMs = Date.now();
    await cdp.send('Profiler.start');
    artifact.journey = await milestone(
      page,
      options.origin,
      progress,
      'profiled',
      navigationBarrier,
    );
    retainProgress();
    artifact.inputBoundaries = await page.evaluate(
      () => window.__inboxPhoneDiagnostics.inputBoundaries,
    );
    artifact.clockBridge.checkpoints.afterJourney = await readClock();
    artifact.navigationClock = await page.evaluate(() => ({
      timeOriginMs: performance.timeOrigin,
      nowMs: performance.now(),
    }));
    artifact.cpuProfile = (await cdp.send('Profiler.stop')).profile;
    artifact.profileEndedWallTimeMs = Date.now();
    artifact.clockBridge.checkpoints.afterProfile = await readClock();
    const { beforeProfile, afterJourney, afterProfile } =
      artifact.clockBridge.checkpoints;
    const required = [
      beforeProfile.Timestamp,
      afterJourney.Timestamp,
      afterJourney.NavigationStart,
      afterProfile.Timestamp,
      afterProfile.NavigationStart,
    ];
    if (!required.every((value) => Number.isFinite(value) && value > 0)) {
      artifact.clockBridge.reason = 'missing-or-invalid-metrics';
    } else {
      const { startTime, endTime, samples, timeDeltas } = artifact.cpuProfile;
      let sampleTimestamp = startTime;
      const sampleTimesCoherent =
        Array.isArray(samples) &&
        Array.isArray(timeDeltas) &&
        timeDeltas.length === samples.length &&
        timeDeltas.every((delta) => {
          if (!Number.isSafeInteger(delta)) return false;
          sampleTimestamp += delta;
          return sampleTimestamp >= startTime && sampleTimestamp <= endTime;
        }) &&
        timeDeltas.reduce((total, delta) => total + delta, 0) <=
          endTime - startTime;
      // Signed deltas can describe out-of-order samples. Preserve them and
      // report sample-order quality separately from the clock-domain bridge.
      artifact.profileSampleOrder = {
        negativeDeltaCount: Array.isArray(timeDeltas)
          ? timeDeltas.filter((delta) => Number.isFinite(delta) && delta < 0)
              .length
          : null,
      };
      const lowerNowMs =
        (afterJourney.Timestamp - afterJourney.NavigationStart) * 1_000;
      const upperNowMs =
        (afterProfile.Timestamp - afterProfile.NavigationStart) * 1_000;
      const coherent =
        sampleTimesCoherent &&
        Number.isFinite(startTime) &&
        Number.isFinite(endTime) &&
        afterJourney.NavigationStart === afterProfile.NavigationStart &&
        beforeProfile.Timestamp <= startTime / 1_000_000 &&
        startTime / 1_000_000 <= afterJourney.Timestamp &&
        afterJourney.Timestamp <= endTime / 1_000_000 &&
        endTime / 1_000_000 <= afterProfile.Timestamp &&
        lowerNowMs >= 0 &&
        Number.isFinite(artifact.navigationClock.timeOriginMs) &&
        artifact.navigationClock.nowMs >= lowerNowMs &&
        artifact.navigationClock.nowMs <= upperNowMs;
      artifact.clockBridge.status = coherent ? 'available' : 'unavailable';
      if (!coherent) artifact.clockBridge.reason = 'incoherent-clock-bracket';
    }
    if (!artifact.cpuProfile.samples?.length) throw Error('Empty profile');
    for (const node of artifact.cpuProfile.nodes)
      node.callFrame.url = diagnosticPath(node.callFrame.url, options.origin);
    stage = 'source-binding';
    if (scripts.size > 32) throw Error('Script count exceeds bounded capture');
    const next = path.resolve('dist/apps/console/.next');
    const append = (collection, value) => {
      collection.push(value);
      if (Buffer.byteLength(JSON.stringify(artifact)) > maxBytes) {
        collection.pop();
        throw Error('Artifact cap exceeded');
      }
    };
    for (const metadata of scripts.values()) {
      if (
        !Number.isInteger(metadata.length) ||
        metadata.length > 2 * 1024 * 1024
      )
        throw Error('Script exceeds bounded capture');
      const { scriptSource } = await cdp.send('Debugger.getScriptSource', {
        scriptId: metadata.scriptId,
      });
      const file = path.join(next, metadata.path.slice('/_next/'.length));
      const generated = await readFile(file);
      const browserSHA256 = sha(scriptSource);
      if (browserSHA256 !== sha(generated))
        throw Error('Browser/build source mismatch');
      append(artifact.sources, {
        ...metadata,
        sha256: browserSHA256,
        source: scriptSource,
      });
    }
    if (!artifact.sources.length) throw Error('No matching generated scripts');
    const captured = new Set(artifact.sources.map((entry) => entry.scriptId));
    for (const node of artifact.cpuProfile.nodes) {
      if (
        node.callFrame.url.startsWith('/_next/static/chunks/') &&
        !captured.has(node.callFrame.scriptId)
      )
        throw Error('Profile script has no exact matching generated source');
    }
    for (const file of BUILD_EVIDENCE_FILES) {
      const data = await readFile(path.join(next, file));
      append(artifact.manifests, {
        path: file,
        sha256: sha(data),
        source: data.toString('utf8'),
      });
    }
    assertDeadline();
    artifact.completedAtMs = Date.now();
    artifact.deadlineAtMs = deadlineAt;
    artifact.status = 'complete';
  } catch {
    artifact.failureStage =
      expired || Date.now() >= deadlineAt ? 'diagnostic-deadline' : stage;
    // Incomplete evidence never masquerades as a successful profile or sample.
  } finally {
    retainProgress();
    snapshotOpen = false;
    clearTimeout(snapshotTimer);
    if (artifact.partialObservation?.status === 'pending') {
      artifact.partialObservation.status = 'unavailable';
      artifact.partialObservation.reason =
        'snapshot-not-completed-before-close';
    }
    let closeError;
    const contextClosed = context?.close().catch((error) => {
      closeError = error;
    });
    if (contextClosed) {
      // Race context cleanup against the remaining diagnostic budget: a
      // stalled renderer close must not outlive the diagnostic window into
      // the whole-run timeout; outer browser cleanup still owns the browser.
      let cleanupTimer;
      const budget = new Promise((resolve) => {
        cleanupTimer = setTimeout(
          resolve,
          Math.max(0, deadlineAt - Date.now()),
        );
      });
      await Promise.race([contextClosed, budget]);
      clearTimeout(cleanupTimer);
    }
    clearTimeout(timer);
    if (closeError) {
      artifact.status = 'incomplete';
      artifact.failureStage = 'context-cleanup';
    }
  }
  if (expired || Date.now() >= deadlineAt) {
    artifact.status = 'incomplete';
    artifact.failureStage = 'diagnostic-deadline';
  }
  let text = JSON.stringify(artifact, null, 2);
  if (Buffer.byteLength(text) + 1 > maxBytes) {
    artifact.status = 'incomplete';
    text = JSON.stringify({
      schemaVersion: 1,
      status: 'incomplete',
      excludedFromBudget: true,
      failureStage: 'artifact-size-cap',
      sourceRevision: report.sourceRevision,
      maxBytes,
    });
  }
  await writeFile(options.cpuProfileOut, text + '\n', { flag: 'wx' });
  if (artifact.status === 'complete' && (expired || Date.now() >= deadlineAt)) {
    artifact.status = 'incomplete';
    artifact.failureStage = 'diagnostic-deadline';
    // Never leave a stale complete file after a deadline or cap refusal.
    let lateText = JSON.stringify(artifact, null, 2);
    if (Buffer.byteLength(lateText) + 1 > maxBytes) {
      artifact.failureStage = 'artifact-size-cap';
      lateText = JSON.stringify({
        schemaVersion: 1,
        status: 'incomplete',
        excludedFromBudget: true,
        failureStage: 'artifact-size-cap',
        sourceRevision: report.sourceRevision,
        navigationBarrier,
        sourceBindings: artifact.sourceBindings,
        attemptStartedAtMs,
        deadlineAtMs: deadlineAt,
        milestoneProgress: artifact.milestoneProgress,
        deadlineMilestoneProgress: artifact.deadlineMilestoneProgress,
        partialObservation: artifact.partialObservation,
      });
    }
    // This is the private file just created successfully by this capture.
    await writeFile(options.cpuProfileOut, lateText + '\n');
  }
  return {
    status: artifact.status,
    out: options.cpuProfileOut,
    excludedFromBudget: true,
  };
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
  let runDeadlineAt;
  const interrupt = () => {
    report.error = 'Measurement interrupted; partial cohort only';
    void browser?.close().catch(() => undefined);
  };
  if (options.tls) process.once('SIGTERM', interrupt);
  try {
    report.environment.network = checkNetworkBoundary();
    report.sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    browser = await chromium.launch({
      ...tlsLaunchOptions(options.tls),
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    report.browserVersion = browser.version();
    if (report.error) throw Error(report.error);
    runDeadlineAt = Date.now() + RUN_TIMEOUT_MS;
    deadline = setTimeout(() => {
      if (!options.cpuProfileOut || !report.summary)
        report.error = 'Measurement exceeded its whole-run deadline';
      void browser.close().catch((error) => {
        report.cleanupError = error.message;
      });
    }, RUN_TIMEOUT_MS);
    if (options.tls)
      report.transport = {
        series: 'opt-in-loopback-tls',
        certificateSHA256: options.tls.certificateSHA256,
        spkiSHA256: options.tls.spkiSHA256,
        buildHashes: await transportBuildHashes(),
      };
    await seed(options.origin, options.tls);
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
          await page.addInitScript(installPageDiagnostics);
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
          const transportResponses = new Map();
          if (options.tls)
            cdp.on(
              'Network.responseReceived',
              ({ requestId, response, type }) => {
                const metadata = transportResponse(
                  response,
                  options.origin,
                  type,
                );
                if (metadata && transportResponses.size < 256)
                  transportResponses.set(requestId, metadata);
              },
            );
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
          transportResponses.clear();
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
          if (options.tls) {
            sample.transportResponses = [...transportResponses.values()];
            if (cache === 'cold') sample.scriptCorpus = [];
            // Retain the completed journey even if subsequent corpus binding
            // fails. Such a report has raw rows and an error, never a summary.
            report.samples.push({ cache, index: index + 1, ...sample });
            if (cache === 'cold') {
              for (const [requestId, metadata] of transportResponses) {
                if (!staticJS.test(metadata.path)) continue;
                const { body, base64Encoded } = await cdp.send(
                  'Network.getResponseBody',
                  { requestId },
                );
                const decoded = Buffer.from(
                  body,
                  base64Encoded ? 'base64' : 'utf8',
                );
                if (decoded.length > 8 * 1024 * 1024)
                  throw Error('Static script exceeds diagnostic cap');
                const built = await readFile(
                  path.join(
                    'dist/apps/console/.next',
                    metadata.path.slice('/_next/'.length),
                  ),
                );
                if (sha256(decoded) !== sha256(built))
                  throw Error('Browser/build static script mismatch');
                const resource = sample.resources.find(
                  (r) => r.path === metadata.path,
                );
                sample.scriptCorpus.push({
                  path: metadata.path,
                  sha256: sha256(decoded),
                  decodedBytes: decoded.length,
                  encodedBytes: resource?.encodedBytes,
                });
              }
              sample.scriptCorpus.sort((a, b) => a.path.localeCompare(b.path));
            }
          }
          if (errors.length)
            throw new Error(
              options.tls
                ? 'Browser reported errors; counts retained in failure diagnostics'
                : `Browser errors: ${errors.join('; ')}`,
            );
          if (!options.tls)
            report.samples.push({ cache, index: index + 1, ...sample });
          console.log(
            `${cache} ${index + 1}/${options.samples}: ${sample.readyMs.toFixed(0)}ms`,
          );
        } catch (error) {
          // Collect while the failing renderer still exists. Queries, origins,
          // credentials, headers, bodies and arbitrary console text stay out.
          const browserErrorsAtFailure = { ...browserErrors };
          const requestsAtFailure = [...requests.values()].map((record) => ({
            ...record,
          }));
          const observation = await failedPageObservation(page);
          report.failureDiagnostics = {
            ...active,
            elapsedMs: elapsedMs(),
            mainFramePath: page
              ? diagnosticPath(page.url(), options.origin)
              : '<unavailable>',
            browserConnected: browser.isConnected(),
            browserErrors: browserErrorsAtFailure,
            requests: requestsAtFailure,
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
    if (options.cpuProfileOut) {
      try {
        report.cpuProfileDiagnostic = await captureColdProfile(
          browser,
          options,
          report,
          runDeadlineAt,
        );
        // A separate fresh cold context after all60 samples and the first
        // diagnostic. It attempts a real click earlier; not a revised SLA row.
        try {
          report.exploratoryInputDiagnostic = await captureColdProfile(
            browser,
            {
              ...options,
              cpuProfileOut: options.cpuProfileOut + '.exploratory.json',
            },
            report,
            runDeadlineAt,
            'domcontentloaded',
          );
        } catch {
          report.exploratoryInputDiagnostic = {
            status: 'incomplete',
            excludedFromBudget: true,
            failureStage: 'exploratory-artifact-write',
          };
        }
      } catch {
        report.cpuProfileDiagnostic = {
          status: 'incomplete',
          excludedFromBudget: true,
          failureStage: 'artifact-write',
        };
      }
    }
  } catch (error) {
    report.error =
      error instanceof Error ? error.message : 'Measurement failed';
  } finally {
    if (options.tls) process.removeListener('SIGTERM', interrupt);
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
    if (report.error) {
      if (options.cpuProfileOut && report.summary)
        report.completedCohortSummary = report.summary;
      delete report.summary;
    }
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
    });
  }
  if (report.error) throw new Error(report.error);
  console.log(JSON.stringify(report.summary, null, 2));
  return report;
}

const exec = promisify(execFile);
const CADDY_URL =
  'https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_amd64.tar.gz';
const CADDY_SHA256 =
  '727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b';
const CADDY_BYTES = 18113754;
const PROBE = path.resolve('tools/e2e/measure-inbox-phone.mjs');
async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  if (!address || typeof address === 'string') throw Error('No loopback port');
  await new Promise((resolve, reject) =>
    socket.close((err) => (err ? reject(err) : resolve())),
  );
  return address.port;
}
async function certificate(directory, name) {
  const cert = path.join(directory, name + '.pem');
  const key = path.join(directory, name + '.key');
  await exec(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { timeout: 15_000, maxBuffer: 64 * 1024 },
  );
  await chmod(key, 0o600);
  return { cert, key };
}
export async function stopTransportChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = once(child, 'exit');
  // Deadline and cleanup can converge on the same child. Never send a second
  // TERM while its first handler is flushing partial rows and closing Chromium.
  if (!child.killed) child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
export async function transportExperiment(options) {
  if (os.platform() !== 'linux' || os.arch() !== 'x64')
    throw Error('Pinned standard Caddy requires linux_amd64');
  if (process.env.E2E_INBOX_TLS_DIAGNOSTIC !== '1')
    throw Error('Transport experiment requires exact hermetic opt-in');
  const backend = new URL(options.origin);
  labOptions(['--origin', backend.origin, '--out', options.out]);
  const artifactPath = (name) => path.join(path.dirname(options.out), name);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inbox-transport-'));
  const report = {
    status: 'incomplete',
    blocks: [],
    caddy: { version: '2.11.7', sha256: CADDY_SHA256, bytes: CADDY_BYTES },
    series:
      'TLS loopback diagnostic; separate from accepted HTTP baseline and production',
  };
  let proxy;
  let helper;
  let smokeBrowser;
  let expired = false;
  // A whole-diagnostic bound inside the unchanged 30-minute job. Helpers
  // retain their own 15-minute ceiling; cleanup only touches owned children.
  const deadlineAt = Date.now() + 24 * 60_000;
  const interruptExperiment = () => {
    expired = true;
    helper?.kill('SIGTERM');
    proxy?.kill('SIGTERM');
    void smokeBrowser?.close();
  };
  process.once('SIGTERM', interruptExperiment);
  const timer = setTimeout(() => {
    expired = true;
    helper?.kill('SIGTERM');
    proxy?.kill('SIGTERM');
    void smokeBrowser?.close();
  }, deadlineAt - Date.now());
  const remaining = () => {
    if (expired || Date.now() >= deadlineAt)
      throw Error('Transport diagnostic deadline');
    return deadlineAt - Date.now();
  };
  try {
    const response = await fetch(CADDY_URL, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.body) throw Error('Caddy download failed');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > CADDY_BYTES) throw Error('Caddy archive exceeds pinned size');
      chunks.push(chunk);
    }
    const archive = Buffer.concat(chunks);
    if (
      bytes !== CADDY_BYTES ||
      createHash('sha256').update(archive).digest('hex') !== CADDY_SHA256
    )
      throw Error('Caddy archive integrity mismatch');
    const archivePath = path.join(directory, 'caddy.tar.gz');
    await writeFile(archivePath, archive);
    await exec('tar', ['-xzf', archivePath, '-C', directory, 'caddy'], {
      timeout: 15_000,
    });
    const caddy = path.join(directory, 'caddy');
    const { stdout } = await exec(caddy, ['version'], { timeout: 5_000 });
    if (!stdout.startsWith('v2.11.7 ')) throw Error('Unexpected Caddy version');
    const pair = await certificate(directory, 'lab');
    const badPair = await certificate(directory, 'unrelated');
    const tls = tlsCertificate(pair.cert, '127.0.0.1');
    const port = await freePort();
    const origin = `https://127.0.0.1:${port}`;
    const badOrigin = `https://127.0.0.1:${await freePort()}`;
    const config = path.join(directory, 'Caddyfile');
    const startProxy = async (arm) => {
      remaining();
      await writeFile(
        config,
        `{
  admin off
  persist_config off
  auto_https off
  servers {
    protocols ${arm === 'h1' ? 'h1' : 'h1 h2'}
  }
}
${origin} {
  bind 127.0.0.1
  tls ${pair.cert} ${pair.key}
  reverse_proxy ${backend.origin} {
    transport http {
      versions 1.1
      compression off
    }
  }
}
${badOrigin} {
  bind 127.0.0.1
  tls ${badPair.cert} ${badPair.key}
  respond "unrelated certificate"
}
`,
      );
      proxy = spawn(
        caddy,
        ['run', '--config', config, '--adapter', 'caddyfile'],
        { stdio: 'ignore' },
      );
      await once(proxy, 'spawn');
      // Observe the owned listener rather than retrying a failed journey.
      await new Promise((resolve, reject) => {
        const expires = Date.now() + 5_000;
        const poll = () => {
          if (proxy?.exitCode !== null || expired)
            return reject(Error('Owned Caddy did not start'));
          const socket = connect(port, '127.0.0.1');
          socket.once('connect', () => {
            socket.destroy();
            resolve();
          });
          socket.once('error', () => {
            socket.destroy();
            if (Date.now() >= expires)
              reject(Error('Owned Caddy listener deadline'));
            else setTimeout(poll, 50);
          });
        };
        poll();
      });
    };
    await startProxy('h1');
    // Positive and negative TLS controls precede cohorts. Node gets an
    // explicit CA; Chromium gets only this exact SPKI in its own process.
    await seed(origin, tls);
    await assert.rejects(seed(badOrigin, tls), {
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    });
    smokeBrowser = await chromium.launch({
      ...tlsLaunchOptions(tls),
      ...(process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']
        ? {
            executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'],
          }
        : {}),
    });
    const smokePage = await smokeBrowser.newPage();
    const valid = await smokePage.goto(origin, {
      timeout: 30_000,
      waitUntil: 'load',
    });
    assert.ok(valid);
    await assert.rejects(
      smokePage.goto(badOrigin, { timeout: 10_000 }),
      /ERR_CERT_AUTHORITY_INVALID/,
    );
    await smokeBrowser.close();
    smokeBrowser = undefined;
    report.tlsSmoke = {
      explicitNodeCA: true,
      exactChromiumSPKI: true,
      unrelatedCertificateRefused: true,
    };
    await stopTransportChild(proxy);
    proxy = undefined;
    for (const [index, arm] of ['h1', 'h2', 'h2', 'h1'].entries()) {
      await startProxy(arm);
      const out = artifactPath(`transport-${index + 1}-${arm}.json`);
      try {
        await new Promise((resolve, reject) => {
          helper = spawn(
            process.execPath,
            [
              PROBE,
              '--origin',
              origin,
              '--tls-diagnostic',
              '--tls-certificate',
              pair.cert,
              '--samples',
              '15',
              '--out',
              out,
            ],
            { stdio: 'ignore' },
          );
          const helperTimer = setTimeout(
            () => {
              helper?.kill('SIGTERM');
              reject(Error('Transport helper deadline'));
            },
            Math.min(15.5 * 60_000, remaining()),
          );
          helper.once('error', reject);
          helper.once('exit', (code) => {
            clearTimeout(helperTimer);
            if (code === 0) resolve();
            else reject(Error(`Transport helper failed: ${code ?? 'signal'}`));
          });
        });
      } finally {
        await stopTransportChild(helper);
        helper = undefined;
        try {
          report.blocks.push({
            arm,
            report: JSON.parse(await readFile(out, 'utf8')),
          });
        } catch {
          report.blocks.push({
            arm,
            report: { error: 'helper-artifact-unavailable', samples: [] },
          });
        } finally {
          await stopTransportChild(proxy);
          proxy = undefined;
        }
      }
      remaining();
    }
    report.summary = transportSummary(report.blocks);
    report.status = 'complete';
  } catch (error) {
    // Fixed failure category avoids retaining subprocess output or credentials.
    report.failure = expired
      ? 'diagnostic-deadline'
      : 'harness-or-transport-incomplete';
    throw error;
  } finally {
    process.removeListener('SIGTERM', interruptExperiment);
    clearTimeout(timer);
    await stopTransportChild(helper);
    await stopTransportChild(proxy);
    await smokeBrowser?.close();
    try {
      await writeFile(options.out, JSON.stringify(report, null, 2) + '\n', {
        flag: 'wx',
      });
    } finally {
      // Only diagnostic JSON lives in test-output; private keys and Caddy stay
      // in this owned temporary directory and are never uploaded.
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = labOptions(process.argv.slice(2));
    if (options.experiment) await transportExperiment(options);
    else await measure(options);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Measurement failed',
    );
    process.exitCode = 1;
  }
}
