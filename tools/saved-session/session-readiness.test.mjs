import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { test } from 'vitest';

import {
  authenticatedSessionReadiness,
  readinessExitCode,
  readinessMessage,
  savedSessionReadiness,
} from './session-readiness.mjs';

const DAY = 86_400;
const NOW = 1_800_000_000;
const execFile = promisify(execFileCallback);
const state = (expires) => ({
  cookies: [{ name: 'authjs.session-token', expires, value: 'dummy-cookie' }],
  origins: [],
});

test('expiry boundaries distinguish expired, expiring, unknown and ready with a rotation deadline', () => {
  assert.equal(savedSessionReadiness(state(NOW), 14, NOW).status, 'expired');
  assert.equal(
    savedSessionReadiness(state(NOW - DAY), 0, NOW).status,
    'expired',
  );
  assert.equal(
    savedSessionReadiness(state(NOW + 14 * DAY - 1), 14, NOW).status,
    'expiring',
  );
  assert.equal(savedSessionReadiness(state(-1), 14, NOW).status, 'unknown');
  const ready = savedSessionReadiness(state(NOW + 14 * DAY), 14, NOW);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.rotateBy, new Date(NOW * 1000).toISOString());
  assert.match(readinessMessage(ready), /SESSION_READY:.*rotateBy=/);
  assert.deepEqual(
    [
      'ready',
      'expired',
      'wrong-role',
      'expiring',
      'unknown',
      'unavailable',
    ].map(readinessExitCode),
    [0, 2, 3, 4, 4, 1],
  );
});

test('the shortest Auth.js chunk controls the rotation deadline', () => {
  const storageState = {
    cookies: [
      { name: '__Secure-authjs.session-token.0', expires: NOW + 30 * DAY },
      { name: '__Secure-authjs.session-token.1', expires: NOW + 7 * DAY },
      { name: 'analytics', expires: NOW - DAY },
    ],
    origins: [],
  };
  assert.equal(savedSessionReadiness(storageState, 14, NOW).status, 'expiring');
});

test('expired state skips network access; authentication and role failures override a valid lifetime', async () => {
  let disposed = 0;
  let requests = 0;
  let payload = { user: { isAdmin: false } };
  const requestFactory = {
    newContext: async () => ({
      get: async (url, options) => {
        requests++;
        assert.equal(url, 'https://console.example/api/auth/session');
        assert.deepEqual(options, { timeout: 10_000, maxRedirects: 0 });
        return { ok: () => true, json: async () => payload };
      },
      dispose: async () => {
        disposed++;
      },
    }),
  };
  const options = {
    origin: 'https://console.example',
    role: 'admin',
    minimumValidDays: 14,
  };
  const dependencies = { requestFactory, nowSeconds: NOW };
  assert.equal(
    (await authenticatedSessionReadiness(state(NOW), options, dependencies))
      .status,
    'expired',
  );
  assert.equal(requests, 0);
  assert.equal(
    (
      await authenticatedSessionReadiness(
        state(NOW + 30 * DAY),
        options,
        dependencies,
      )
    ).status,
    'wrong-role',
  );
  payload = {};
  assert.equal(
    (
      await authenticatedSessionReadiness(
        state(NOW + 30 * DAY),
        options,
        dependencies,
      )
    ).status,
    'expired',
  );
  assert.equal(disposed, 2);
});

test('readiness disposes its isolated context when Auth.js fails', async () => {
  let disposed = false;
  await assert.rejects(
    authenticatedSessionReadiness(
      state(NOW + 30 * DAY),
      {
        origin: 'https://console.example',
        role: 'admin',
        minimumValidDays: 14,
      },
      {
        nowSeconds: NOW,
        requestFactory: {
          newContext: async () => ({
            get: async () => ({ ok: () => false }),
            dispose: async () => {
              disposed = true;
            },
          }),
        },
      },
    ),
    /request failed/,
  );
  assert.equal(disposed, true);
});

test('readiness CLI makes only the Auth.js GET and never rewrites its private saved state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lcars-readiness-'));
  const stateFile = path.join(directory, 'admin.json');
  const storageState = {
    cookies: [
      {
        name: 'authjs.session-token',
        value: 'dummy-test-cookie',
        domain: '127.0.0.1',
        path: '/',
        expires: Date.now() / 1000 + 30 * DAY,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  };
  const serialized = JSON.stringify(storageState);
  await writeFile(stateFile, serialized, { mode: 0o600 });
  const received = [];
  const server = createServer((req, res) => {
    received.push({ method: req.method, url: req.url });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ user: { isAdmin: true } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { stdout } = await execFile(
      process.execPath,
      [
        path.resolve('tools/saved-session/check.mjs'),
        '--origin',
        `http://127.0.0.1:${server.address().port}`,
        '--state-file',
        stateFile,
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    assert.match(stdout, /SESSION_READY:.*expiresAt=.*rotateBy=/);
    assert.doesNotMatch(stdout, /dummy-test-cookie/);
    assert.deepEqual(received, [{ method: 'GET', url: '/api/auth/session' }]);
    assert.equal(await readFile(stateFile, 'utf8'), serialized);
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
