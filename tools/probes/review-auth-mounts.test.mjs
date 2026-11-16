import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  codexRefreshDueMs,
  ensureCodexLoginOutlivesRun,
  nativeAuthMounts,
} from './review-auth-mounts.mjs';

function withDirs(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'review-auth-mounts-'));
  const auth = join(dir, 'auth');
  mkdirSync(auth);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(auth, join(dir, 'native-home'));
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result instanceof Promise) return result.finally(cleanup);
  cleanup();
  return result;
}

function callerHome(auth, credential) {
  writeFileSync(join(auth, credential), '{}\n');
  writeFileSync(join(auth, 'settings.json'), '{"hooks":{}}\n');
  mkdirSync(join(auth, 'hooks'));
}

test('Claude gets an empty private home and no caller directory at all', () => {
  withDirs((_auth, home) => {
    assert.deepEqual(nativeAuthMounts('claude', null, home, '/native/claude'), [
      '--mount',
      `type=bind,source=${home},target=/native/claude`,
    ]);
    assert.deepEqual(readdirSync(home), []);
    assert.equal(statSync(home).mode & 0o777, 0o700);
  });
});

test('Codex and Antigravity bind only their credential, read-only, into a private home', () => {
  withDirs((auth, home) => {
    callerHome(auth, 'auth.json');
    assert.deepEqual(nativeAuthMounts('codex', auth, home, auth), [
      '--mount',
      `type=bind,source=${home},target=${auth}`,
      '--mount',
      `type=bind,source=${join(auth, 'auth.json')},target=${join(auth, 'auth.json')},readonly`,
    ]);
    assert.deepEqual(readdirSync(home), ['auth.json']);
  });
  withDirs((auth, home) => {
    callerHome(auth, 'antigravity-oauth-token');
    assert.equal(
      nativeAuthMounts('agy', auth, home, '/native/agy').at(-1),
      `type=bind,source=${join(auth, 'antigravity-oauth-token')},target=/native/agy/antigravity-oauth-token,readonly`,
    );
  });
});

test('a missing, symlinked or pre-existing credential path refuses the launch', () => {
  withDirs((auth, home) => {
    assert.throws(
      () => nativeAuthMounts('codex', auth, home, auth),
      /missing or not a regular file/,
    );
  });
  withDirs((auth, home) => {
    writeFileSync(join(auth, 'real.json'), '{}\n');
    symlinkSync(join(auth, 'real.json'), join(auth, 'auth.json'));
    assert.throws(
      () => nativeAuthMounts('codex', auth, home, auth),
      /missing or not a regular file/,
    );
  });
  withDirs((auth, home) => {
    mkdirSync(home);
    assert.throws(() => nativeAuthMounts('claude', null, home, '/x'), /EEXIST/);
  });
  assert.deepEqual(nativeAuthMounts('opencode', '/x', '/y', '/z'), []);
  assert.throws(
    () => nativeAuthMounts('other', '/x', '/y', '/z'),
    /Unknown provider/,
  );
});

const jwt = (expSeconds) =>
  [
    'h',
    Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url'),
    's',
  ].join('.');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RUN = 82 * 60 * 1000;
const writeCodexAuth = (auth, expMs, lastRefreshMs) =>
  writeFileSync(
    join(auth, 'auth.json'),
    JSON.stringify({
      tokens: { access_token: jwt(expMs / 1000) },
      last_refresh: new Date(lastRefreshMs).toISOString(),
    }),
  );

test('Codex refreshes at the earlier of token expiry and last_refresh + 8 days', () => {
  withDirs((auth) => {
    const now = 1_800_000_000_000;
    writeCodexAuth(auth, now + 8 * DAY, now - 2 * DAY);
    assert.equal(codexRefreshDueMs(auth), now + 6 * DAY);
    writeCodexAuth(auth, now + HOUR, now - 2 * DAY);
    assert.equal(codexRefreshDueMs(auth), now + HOUR);
    writeFileSync(join(auth, 'auth.json'), JSON.stringify({ tokens: {} }));
    assert.equal(codexRefreshDueMs(auth), null);
  });
});

test('a Codex login that outlives the run launches immediately', async () => {
  await withDirs(async (auth) => {
    const now = 1_800_000_000_000;
    writeCodexAuth(auth, now + 9 * DAY, now - DAY);
    let refreshed = 0;
    await ensureCodexLoginOutlivesRun({
      auth,
      runMs: RUN,
      now: () => now,
      sleep: async () => assert.fail('must not wait'),
      refresh: async () => (refreshed += 1),
      log: () => {},
    });
    assert.equal(refreshed, 0);
  });
});

test('a Codex refresh due inside the run is waited for and done on the host, never refused', async () => {
  await withDirs(async (auth) => {
    let clock = 1_800_000_000_000;
    // last_refresh + 8 days lands 40 minutes from now.
    writeCodexAuth(auth, clock + 2 * DAY, clock - 8 * DAY + 40 * 60 * 1000);
    const waits = [];
    let refreshed = 0;
    await ensureCodexLoginOutlivesRun({
      auth,
      runMs: RUN,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      // The host request makes Codex persist a fresh login.
      refresh: async () => {
        refreshed += 1;
        writeCodexAuth(auth, clock + 10 * DAY, clock);
      },
      log: () => {},
    });
    assert.deepEqual(waits, [41 * 60 * 1000]);
    assert.equal(refreshed, 1);
  });
});

test('a live host session that refreshes during the wait makes the host request unnecessary', async () => {
  await withDirs(async (auth) => {
    let clock = 1_800_000_000_000;
    writeCodexAuth(auth, clock + 30 * 60 * 1000, clock - DAY);
    let refreshed = 0;
    await ensureCodexLoginOutlivesRun({
      auth,
      runMs: RUN,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        writeCodexAuth(auth, clock + 10 * DAY, clock);
      },
      refresh: async () => (refreshed += 1),
      log: () => {},
    });
    assert.equal(refreshed, 0);
  });
});

test('only a host that cannot refresh the Codex login stops the launch', async () => {
  await withDirs(async (auth) => {
    const now = 1_800_000_000_000;
    writeCodexAuth(auth, now - HOUR, now - 9 * DAY);
    let refreshed = 0;
    await assert.rejects(
      ensureCodexLoginOutlivesRun({
        auth,
        runMs: RUN,
        now: () => now,
        sleep: async () => {},
        refresh: async () => (refreshed += 1),
        log: () => {},
      }),
      /could not be refreshed on the host/,
    );
    assert.equal(refreshed, 3);
  });
});
