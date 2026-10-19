import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as httpsServer } from 'node:https';
import { connect, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { chromium, expect, test } from '@playwright/test';

import {
  labOptions,
  seed,
  tlsCertificate,
  tlsLaunchOptions,
  transportSummary,
} from '../../../tools/e2e/measure-inbox-phone.mjs';

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
  await new Promise<void>((resolve, reject) =>
    socket.close((err) => (err ? reject(err) : resolve())),
  );
  return address.port;
}

async function certificate(directory: string, name: string) {
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

async function stop(process: ChildProcess | undefined) {
  if (!process?.pid || process.exitCode !== null || process.signalCode !== null)
    return;
  const exited = once(process, 'exit');
  process.kill('SIGTERM');
  const timer = setTimeout(() => process.kill('SIGKILL'), 3_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

// This spec is an owned opt-in signal, excluded from ordinary required CI.
// It uses the normal hermetic standalone server and emulators already running.
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
    if (os.platform() !== 'linux' || os.arch() !== 'x64')
      throw Error('Pinned standard Caddy requires linux_amd64');
    const backend = new URL(baseURL ?? 'http://127.0.0.1:4200');
    labOptions([
      '--origin',
      backend.origin,
      '--out',
      testInfo.outputPath('safety.json'),
    ]);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'inbox-transport-'));
    const report: {
      status: string;
      blocks: { arm: string; report: ReturnType<typeof JSON.parse> }[];
      [key: string]: unknown;
    } = {
      status: 'incomplete',
      blocks: [],
      caddy: { version: '2.11.7', sha256: CADDY_SHA256, bytes: CADDY_BYTES },
      series:
        'TLS loopback diagnostic; separate from accepted HTTP baseline and production',
    };
    let proxy: ChildProcess | undefined;
    let helper: ChildProcess | undefined;
    let smokeBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let unrelated: ReturnType<typeof httpsServer> | undefined;
    let expired = false;
    // A whole-diagnostic bound inside the unchanged 30-minute job. Helpers
    // retain their own 15-minute ceiling; cleanup only touches owned children.
    const deadlineAt = Date.now() + 24 * 60_000;
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
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > CADDY_BYTES)
          throw Error('Caddy archive exceeds pinned size');
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
      if (!stdout.startsWith('v2.11.7 '))
        throw Error('Unexpected Caddy version');
      const pair = await certificate(directory, 'lab');
      const badPair = await certificate(directory, 'unrelated');
      const tls = tlsCertificate(pair.cert, '127.0.0.1');
      const port = await freePort();
      const origin = `https://127.0.0.1:${port}`;
      const config = path.join(directory, 'Caddyfile');
      const startProxy = async (arm: string) => {
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
`,
        );
        proxy = spawn(
          caddy,
          ['run', '--config', config, '--adapter', 'caddyfile'],
          { stdio: 'ignore' },
        );
        await once(proxy, 'spawn');
        // Observe the owned listener rather than retrying a failed journey.
        await new Promise<void>((resolve, reject) => {
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
      unrelated = httpsServer(
        {
          cert: await readFile(badPair.cert),
          key: await readFile(badPair.key),
        },
        (_req, res) => res.end('unrelated certificate'),
      );
      unrelated.listen(0, '127.0.0.1');
      await once(unrelated, 'listening');
      const badAddress = unrelated.address();
      if (!badAddress || typeof badAddress === 'string')
        throw Error('Missing negative TLS listener');
      const badOrigin = `https://127.0.0.1:${badAddress.port}`;
      await expect(seed(badOrigin, tls)).rejects.toThrow();
      smokeBrowser = await chromium.launch({
        ...tlsLaunchOptions(tls),
        ...(process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']
          ? {
              executablePath:
                process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'],
            }
          : {}),
      });
      const smokePage = await smokeBrowser.newPage();
      const valid = await smokePage.goto(origin, {
        timeout: 30_000,
        waitUntil: 'load',
      });
      expect(valid).not.toBeNull();
      await expect(
        smokePage.goto(badOrigin, { timeout: 10_000 }),
      ).rejects.toThrow(/ERR_CERT_AUTHORITY_INVALID/);
      await smokeBrowser.close();
      smokeBrowser = undefined;
      unrelated.closeAllConnections();
      await new Promise<void>((resolve) => unrelated!.close(() => resolve()));
      unrelated = undefined;
      report.tlsSmoke = {
        explicitNodeCA: true,
        exactChromiumSPKI: true,
        unrelatedCertificateRefused: true,
      };
      await stop(proxy);
      proxy = undefined;
      for (const [index, arm] of ['h1', 'h2', 'h2', 'h1'].entries()) {
        await startProxy(arm);
        const out = testInfo.outputPath(`transport-${index + 1}-${arm}.json`);
        try {
          await new Promise<void>((resolve, reject) => {
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
              else
                reject(Error(`Transport helper failed: ${code ?? 'signal'}`));
            });
          });
        } finally {
          await stop(helper);
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
            await stop(proxy);
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
      clearTimeout(timer);
      await stop(helper);
      await stop(proxy);
      await smokeBrowser?.close();
      unrelated?.closeAllConnections();
      if (unrelated)
        await new Promise<void>((resolve) => unrelated!.close(() => resolve()));
      await writeFile(
        testInfo.outputPath('transport-summary.json'),
        JSON.stringify(report, null, 2) + '\n',
      );
      // Only diagnostic JSON lives in test-output; private keys and Caddy stay
      // in this owned temporary directory and are never uploaded.
      await rm(directory, { recursive: true, force: true });
    }
  });
});
