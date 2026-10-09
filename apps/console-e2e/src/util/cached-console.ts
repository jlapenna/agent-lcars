import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';

import { expect } from '@playwright/test';
import { encode } from 'next-auth/jwt';

/** Only an emulator-bound second production server; the fixture auth/cache
 * adapters are deliberately disabled to test the real persistent cache. */
export async function startCachedConsole() {
  if (
    process.env['E2E_HERMETIC'] !== '1' ||
    process.env['PROJECT_ID'] !== 'demo-no-project' ||
    !process.env['FIRESTORE_EMULATOR_HOST']
  ) {
    throw new Error('Production cache proof requires the hermetic emulator');
  }
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('No local port');
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ['dist/apps/console/.next/standalone/apps/console/server.js'],
    {
      env: {
        ...process.env,
        PORT: String(port),
        HOSTNAME: '127.0.0.1',
        AUTH_URL: url,
        AUTH_SECRET: 'dummy-secret',
        AUTH_TRUST_HOST: 'true',
        E2E_TESTING: 'false',
        AGENT_CONSOLE_GITHUB_API_BASE_URL:
          'http://127.0.0.1:4200/api/e2e/github',
        AGENT_LCARS_APP_PRIVATE_KEY: generateKeyPairSync('rsa', {
          modulusLength: 2048,
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        }).privateKey,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let logs = '';
  child.stdout.on('data', (data) => {
    logs = (logs + String(data)).slice(-4000);
  });
  child.stderr.on('data', (data) => {
    logs = (logs + String(data)).slice(-4000);
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await once(child, 'exit');
  };
  try {
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null)
            throw new Error(`Cache proof server failed: ${logs}`);
          return fetch(`${url}/login`)
            .then((response) => response.status)
            .catch(() => 0);
        },
        { timeout: 20_000 },
      )
      .toBe(200);
  } catch (error) {
    await stop();
    throw error;
  }
  return { url, stop };
}

export async function cachedConsoleSession(url: string) {
  const name = 'authjs.session-token';
  const value = await encode({
    secret: 'dummy-secret',
    salt: name,
    maxAge: 3600,
    token: {
      sub: 'e2e-agent-lcars-admin',
      githubLogin: 'e2e-agent-lcars-admin',
      isAdmin: true,
      name: 'Local cache proof',
    },
  });
  return { name, value, url };
}
