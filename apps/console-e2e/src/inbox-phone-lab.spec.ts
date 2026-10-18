import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import { resetCliSessions } from './seed';

function expectIncompleteExploration(extra: ReturnType<typeof JSON.parse>) {
  expect(extra.status).toBe('incomplete');
  expect(extra.excludedFromBudget).toBe(true);
  expect(extra.navigationBarrier).toBe('domcontentloaded');
  expect(extra.failureStage).toBe('diagnostic-deadline');
  expect(extra.journey).toBeUndefined();
  expect(extra.deadlineMilestoneProgress.stage).toMatch(
    /^profiled\.(document-load|decision-content|primary-action|confirmation|cancel)$/,
  );
  expect(extra.deadlineAtMs - extra.attemptStartedAtMs).toBeLessThanOrEqual(
    30_000,
  );
  expect(extra.deadlineAtMs).toBeGreaterThan(extra.attemptStartedAtMs);
  const names = [
    'navigation-returned',
    'decision-content-visible',
    'primary-click-returned',
    'confirmation-visible',
    'cancel-returned',
  ];
  let previous = -1;
  for (const checkpoint of extra.deadlineMilestoneProgress
    .completedCheckpoints) {
    const index = names.indexOf(checkpoint.name);
    expect(index).toBeGreaterThan(previous);
    previous = index;
    expect(Number.isFinite(checkpoint.completedAtMs)).toBe(true);
    expect(checkpoint.completedAtMs).toBeLessThan(extra.deadlineAtMs);
  }
  expect(Object.keys(extra.sourceBindings)).toHaveLength(5);
  for (const value of Object.values(extra.sourceBindings))
    expect(value).toMatch(/^[a-f0-9]{64}$/);
  expect(['observed', 'unavailable']).toContain(
    extra.partialObservation.status,
  );
  if (extra.partialObservation.status === 'observed') {
    expect(Number.isFinite(extra.partialObservation.value.nowMs)).toBe(true);
    expect(extra.partialObservation.requestedAtMs).toBeGreaterThanOrEqual(
      extra.attemptStartedAtMs,
    );
    expect(extra.partialObservation.completedAtMs).toBeGreaterThanOrEqual(
      extra.partialObservation.requestedAtMs,
    );
    expect(extra.partialObservation.completedAtMs).toBeLessThan(
      extra.deadlineAtMs,
    );
  } else {
    expect([
      'page-not-created',
      'page-observation-failed',
      'snapshot-not-completed-before-close',
    ]).toContain(extra.partialObservation.reason);
  }
}

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
    const cpuProfile = testInfo.outputPath('inbox-phone-cpu-profile.json');
    await resetCliSessions();
    let primaryFailure: unknown;
    let labAttachmentFailure: unknown;
    let cpuAttachmentFailure: unknown;
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
          '--cpu-profile-out',
          cpuProfile,
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
      // Separate diagnostic, never a 61st budget sample or p95 input.
      const diagnostic = JSON.parse(await readFile(cpuProfile, 'utf8'));
      expect(diagnostic.status).toBe('complete');
      expect(diagnostic.excludedFromBudget).toBe(true);
      const exploratory = JSON.parse(
        await readFile(cpuProfile + '.exploratory.json', 'utf8'),
      );
      expect(diagnostic.navigationBarrier).toBe('load');
      expect(exploratory.navigationBarrier).toBe('domcontentloaded');
      // The optional earlier attempt may time out honestly; never call it complete.
      if (exploratory.status !== 'complete')
        expectIncompleteExploration(exploratory);
      for (const extra of [
        diagnostic,
        ...(exploratory.status === 'complete' ? [exploratory] : []),
      ]) {
        expect(extra.status).toBe('complete');
        expect(extra.excludedFromBudget).toBe(true);
      }

      expect(diagnostic.cpuProfile.samples.length).toBeGreaterThan(0);
      expect(diagnostic.sources.length).toBeGreaterThan(0);
      for (const sample of report.samples) {
        expect(sample.loadEventMs).toBeGreaterThan(0);
        expect(sample.documentTransferBytes).toBeGreaterThanOrEqual(0);
        expect(sample.documentEncodedBytes).toBeGreaterThan(0);
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
        for (const value of [
          sample.fetchStartMs,
          sample.connectStartMs,
          sample.secureConnectionStartMs,
          sample.connectEndMs,
          sample.requestStartMs,
          sample.documentDecodedBytes,
        ])
          expect(Number.isFinite(value) && value >= 0).toBe(true);
        expect(typeof sample.nextHopProtocol).toBe('string');
        for (const entry of sample.resources) {
          for (const value of [
            entry.fetchStartMs,
            entry.connectStartMs,
            entry.secureConnectionStartMs,
            entry.connectEndMs,
            entry.requestStartMs,
            entry.decodedBytes,
          ])
            expect(Number.isFinite(value) && value >= 0).toBe(true);
          expect(typeof entry.nextHopProtocol).toBe('string');
        }
      }
    } catch (error) {
      primaryFailure = error;
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
      } catch (attachmentError) {
        labAttachmentFailure = attachmentError;
      }
      try {
        await testInfo.attach(
          'Inbox cold CPU diagnostic (excluded from budget)',
          {
            path: cpuProfile,
            contentType: 'application/json',
          },
        );
      } catch (attachmentError) {
        // Missing diagnostic must not mask the real lab failure.
        cpuAttachmentFailure = attachmentError;
      }
      try {
        await testInfo.attach(
          'Exploratory earlier-barrier input diagnostic (excluded)',
          {
            path: cpuProfile + '.exploratory.json',
            contentType: 'application/json',
          },
        );
      } catch (attachmentError) {
        cpuAttachmentFailure ??= attachmentError;
      }
      await resetCliSessions();
    }
    // No throw inside finally: the real lab failure is reported first, and
    // the optional diagnostic attachment never masks it.
    const pendingFailure =
      labAttachmentFailure ?? primaryFailure ?? cpuAttachmentFailure;
    if (pendingFailure) throw pendingFailure;
  });
  test('retains a real load-blocking request before cleanup and keeps normal measurement functional', async () => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'inbox-phone-navigation-'),
    );
    let blocked = true;
    let primaryClicks = 0;
    let forceExploratoryTimeout = false;
    let probeNavigations = 0;
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
        const noDialog = forceExploratoryTimeout && ++probeNavigations === 17;
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(`<div class="queue-workspace__detail">
          <p>feat(console): tap-icon refresh on the queue header</p>
          <button class="queue-primary-action" onclick="window.__inboxPhoneDiagnostics?.recordPrimaryBoundary?.('handlerEntryMs'); fetch('/click'); if (!${noDialog}) document.querySelector('dialog').showModal(); window.__inboxPhoneDiagnostics?.recordPrimaryBoundary?.('openConfirmReturnMs')">Approve &amp; Rebase</button>
          </div><dialog role="dialog" aria-label="Rebase #9003?">
          <button onclick="this.closest('dialog').close()">Cancel</button>
          </dialog><script>window.__inboxPhoneDiagnostics?.recordPrimaryBoundary?.('primaryCommitMs')</script><script src="/blocked.js?private-query-sentinel=secret"></script>`);
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
    const runProbe = (out: string, cpuProfile?: string) =>
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
          ...(cpuProfile ? ['--cpu-profile-out', cpuProfile] : []),
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

      forceExploratoryTimeout = true;
      probeNavigations = 0;
      const partialOut = path.join(directory, 'partial.json');
      const partialCPU = path.join(directory, 'partial-cpu.json');
      await runProbe(partialOut, partialCPU);
      const completed = JSON.parse(await readFile(partialOut, 'utf8'));
      expect(completed.error).toBeUndefined();
      expect(completed.samples).toHaveLength(10);
      expect(JSON.parse(await readFile(partialCPU, 'utf8')).status).toBe(
        'complete',
      );
      const partialBytes = await readFile(partialCPU + '.exploratory.json');
      expect(partialBytes.length).toBeLessThanOrEqual(8 * 1024 * 1024);
      const partial = JSON.parse(partialBytes.toString());
      expectIncompleteExploration(partial);
      expect(partial.deadlineMilestoneProgress.stage).toBe(
        'profiled.confirmation',
      );
      expect(
        partial.deadlineMilestoneProgress.completedCheckpoints.map(
          (x: { name: string }) => x.name,
        ),
      ).toEqual([
        'navigation-returned',
        'decision-content-visible',
        'primary-click-returned',
      ]);
      expect(partial.partialObservation.status).toBe('observed');
      // Native dialog exists closed; actual confirmation wait still never returned.
      expect(partial.partialObservation.value.matchingDialogPresent).toBe(true);
      for (const failureStage of [
        'artifact-size-cap',
        'source-binding',
        'setup',
      ])
        expect(() =>
          expectIncompleteExploration({ ...partial, failureStage }),
        ).toThrow();
      forceExploratoryTimeout = false;
      await runProbe(path.join(directory, 'restored.json'));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });
});
