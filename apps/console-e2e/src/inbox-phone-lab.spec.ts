import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import { resetCliSessions } from './seed';

// This is an owned performance signal for #2201 as well as a browser
// contract for the probe. A missed machine-dependent budget never replaces
// the semantic E2E gate with a timing threshold. Retain raw evidence instead.
test.describe('Inbox phone measurement artifact', () => {
  test.describe.configure({ retries: 0 });

  test('records cold and warm decision readiness without confirming an action', async ({
    baseURL,
  }, testInfo) => {
    // The probe owns a 15-minute whole-run ceiling and 30-second operation
    // ceilings. This selected serial lab needs longer than ordinary journeys.
    test.setTimeout(16 * 60_000);
    const out = testInfo.outputPath('inbox-phone-lab.json');
    await resetCliSessions();
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          path.resolve('tools/e2e/measure-inbox-phone.mjs'),
          '--origin',
          baseURL ?? 'http://127.0.0.1:4200',
          '--samples',
          '30',
          '--out',
          out,
        ],
        { timeout: 15.5 * 60_000, maxBuffer: 1024 * 1024 },
      );
      console.log(stdout);
      const report = JSON.parse(await readFile(out, 'utf8'));
      expect(report.error).toBeUndefined();
      expect(report.samples).toHaveLength(60);
      for (const cache of ['cold', 'warm']) {
        expect(report.summary[cache].n).toBe(30);
        expect(report.summary[cache].p95Ms).toBeGreaterThan(0);
      }
      for (const sample of report.samples) {
        expect(sample.loadEventMs).toBeGreaterThan(0);
        expect(sample.primaryClickDispatchedMs).toBeGreaterThanOrEqual(
          sample.clickRequestedMs,
        );
        expect(sample.readyMs).toBeGreaterThanOrEqual(
          sample.primaryClickDispatchedMs,
        );
        expect(
          sample.resources.some(
            (entry: { type: string }) => entry.type === 'script',
          ),
        ).toBe(true);
        expect(sample.mainThreadMs.TaskDuration).toBeGreaterThan(0);
        for (const value of Object.values(sample.mainThreadMs)) {
          expect(value).toBeGreaterThanOrEqual(0);
        }
      }
    } finally {
      // Preserve partial diagnostics too. Attachment failure must not bypass
      // fixture cleanup, and a failed probe never acquires a passing summary.
      try {
        await testInfo.attach(
          'Inbox phone lab (controlled CI, not production RUM)',
          {
            path: out,
            contentType: 'application/json',
          },
        );
      } finally {
        await resetCliSessions();
      }
    }
  });
  test('retains a real load-blocking request before cleanup and keeps normal measurement functional', async () => {
    test.setTimeout(60_000);
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'inbox-phone-navigation-'),
    );
    let blocked = true;
    let primaryClicks = 0;
    const server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      if (url.pathname === '/api/e2e/seed') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
      } else if (url.pathname === '/blocked.js') {
        if (!blocked) {
          response.writeHead(200, { 'Content-Type': 'application/javascript' });
          response.end('/* finished controlled resource */');
        }
      } else if (url.pathname === '/click') {
        primaryClicks++;
        response.end();
      } else if (url.pathname === '/inbox') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(`<div class="queue-workspace__detail">
          <p>feat(console): tap-icon refresh on the queue header</p>
          <button onclick="fetch('/click'); document.querySelector('dialog').showModal()">Approve &amp; Rebase</button>
          </div><dialog aria-label="Rebase #9003?">
          <button onclick="this.closest('dialog').close()">Cancel</button>
          </dialog><script src="/blocked.js?private-query-sentinel=secret"></script>`);
      } else response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('Missing fixture port');
    const origin = `http://127.0.0.1:${address.port}`;
    const failureOut = path.join(directory, 'failed.json');
    const runProbe = (out: string) =>
      promisify(execFile)(
        process.execPath,
        [
          path.resolve('tools/e2e/measure-inbox-phone.mjs'),
          '--origin',
          origin,
          '--samples',
          '5',
          '--out',
          out,
        ],
        {
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            E2E_HERMETIC: '1',
            PROJECT_ID: 'demo-no-project',
            FIRESTORE_EMULATOR_HOST: '127.0.0.1:4362',
          },
        },
      );
    try {
      await expect(runProbe(failureOut)).rejects.toThrow(/Timeout 30000ms/);
      const failure = JSON.parse(await readFile(failureOut, 'utf8'));
      expect(failure.samples).toEqual([]);
      expect(failure.summary).toBeUndefined();
      expect(primaryClicks).toBe(0);
      expect(failure.failureDiagnostics).toMatchObject({
        cache: 'warm',
        index: 1,
        stage: 'warmup.document-load',
        mainFramePath: '/inbox',
        browserConnected: true,
      });
      expect(failure.failureDiagnostics.observation).toMatchObject({
        status: 'observed',
        readyState: 'loading',
      });
      expect(failure.failureDiagnostics.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: '/inbox',
            mainFrame: true,
            status: 200,
          }),
          expect.objectContaining({ path: '/blocked.js', type: 'script' }),
        ]),
      );
      const pending = failure.failureDiagnostics.requests.find(
        (entry: { path: string }) => entry.path === '/blocked.js',
      );
      expect(pending).not.toHaveProperty('responseMs');
      expect(pending).not.toHaveProperty('finishedMs');
      expect(pending).not.toHaveProperty('failedMs');
      expect(pending).not.toHaveProperty('failure');
      expect(failure.failureDiagnostics.browserErrors).toEqual({
        page: 0,
        console: 0,
        crashed: false,
      });
      expect(JSON.stringify(failure.failureDiagnostics)).not.toContain(
        'private-query-sentinel',
      );
      expect(JSON.stringify(failure.failureDiagnostics)).not.toContain(
        'secret',
      );

      blocked = false;
      const positiveOut = path.join(directory, 'positive.json');
      await runProbe(positiveOut);
      const positive = JSON.parse(await readFile(positiveOut, 'utf8'));
      expect(positive.error).toBeUndefined();
      expect(positive.failureDiagnostics).toBeUndefined();
      expect(positive.samples).toHaveLength(10);
      expect(positive.summary.cold.n).toBe(5);
      expect(positive.summary.warm.n).toBe(5);
      for (const sample of positive.samples) {
        expect(sample.loadEventMs).toBeGreaterThan(0);
        expect(sample.readyMs).toBeGreaterThanOrEqual(
          sample.primaryClickDispatchedMs,
        );
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });
});
