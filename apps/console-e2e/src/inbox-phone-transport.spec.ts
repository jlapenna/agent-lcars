import { spawn } from 'node:child_process';
import path from 'node:path';

import { test } from '@playwright/test';

// The standalone tool owns TLS/proxy/process lifetimes. This spec uses the
// same executable boundary as the existing phone lab, never a project import.
test.describe('Inbox phone TLS transport diagnostic', () => {
  test.describe.configure({ retries: 0 });

  test('counterbalances H1 H2 H2 H1 without changing the bundle', async ({
    baseURL,
  }, testInfo) => {
    test.skip(
      process.env['E2E_INBOX_TLS_DIAGNOSTIC'] !== '1',
      'Manual qualified-sandbox diagnostic only',
    );
    test.setTimeout(26 * 60_000);
    const child = spawn(
      process.execPath,
      [
        path.resolve('tools/e2e/measure-inbox-phone.mjs'),
        '--transport-experiment',
        '--origin',
        baseURL ?? 'http://127.0.0.1:4200',
        '--out',
        testInfo.outputPath('transport-summary.json'),
      ],
      { stdio: 'inherit' },
    );
    await new Promise<void>((resolve, reject) => {
      // Tool deadline is 24m; allow bounded diagnostic flush/reaping before
      // escalating only this owned process. The job remains bounded at 30m.
      const terminate = setTimeout(() => child.kill('SIGTERM'), 24.5 * 60_000);
      const kill = setTimeout(() => child.kill('SIGKILL'), 25 * 60_000);
      child.once('error', (error) => {
        clearTimeout(terminate);
        clearTimeout(kill);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(terminate);
        clearTimeout(kill);
        if (code === 0) resolve();
        else reject(Error(`Transport diagnostic failed: ${code ?? 'signal'}`));
      });
    });
  });
});
