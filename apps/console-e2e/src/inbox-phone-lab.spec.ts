import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
});
