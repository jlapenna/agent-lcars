import assert from 'node:assert/strict';
import {
  existsSync,
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
  assertCredentialsOutliveRun,
  nativeAuthMounts,
} from './review-auth-mounts.mjs';

function withDirs(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'review-auth-mounts-'));
  const auth = join(dir, 'auth');
  mkdirSync(auth);
  try {
    return fn(auth, join(dir, 'native-home'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The caller's directory holds far more than credentials.
function callerHome(auth, credential) {
  writeFileSync(join(auth, credential), '{}\n');
  writeFileSync(join(auth, 'settings.json'), '{"hooks":{}}\n');
  mkdirSync(join(auth, 'hooks'));
  mkdirSync(join(auth, 'projects'));
}

test('Claude gets a private home with only its credential bound read-only', () => {
  withDirs((auth, home) => {
    callerHome(auth, '.credentials.json');
    assert.deepEqual(nativeAuthMounts('claude', auth, home, '/native/claude'), [
      '--mount',
      `type=bind,source=${home},target=/native/claude`,
      '--mount',
      `type=bind,source=${join(auth, '.credentials.json')},target=/native/claude/.credentials.json,readonly`,
    ]);
    // The private home holds only the mount point, never caller content.
    assert.deepEqual(readdirSync(home), ['.credentials.json']);
    assert.equal(statSync(join(home, '.credentials.json')).size, 0);
    assert.equal(statSync(home).mode & 0o777, 0o700);
  });
});

test('Codex and Antigravity credentials are bound read-only into a private home at the target', () => {
  withDirs((auth, home) => {
    callerHome(auth, 'auth.json');
    assert.deepEqual(nativeAuthMounts('codex', auth, home, auth), [
      '--mount',
      `type=bind,source=${home},target=${auth}`,
      '--mount',
      `type=bind,source=${join(auth, 'auth.json')},target=${join(auth, 'auth.json')},readonly`,
    ]);
  });
  withDirs((auth, home) => {
    callerHome(auth, 'antigravity-oauth-token');
    assert.deepEqual(
      nativeAuthMounts('agy', auth, home, '/native/agy').at(-1),
      `type=bind,source=${join(auth, 'antigravity-oauth-token')},target=/native/agy/antigravity-oauth-token,readonly`,
    );
  });
});

test('a missing, symlinked or pre-existing credential path refuses the launch', () => {
  withDirs((auth, home) => {
    assert.throws(
      () => nativeAuthMounts('claude', auth, home, '/native/claude'),
      /missing or not a regular file/,
    );
  });
  withDirs((auth, home) => {
    writeFileSync(join(auth, 'real.json'), '{}\n');
    symlinkSync(join(auth, 'real.json'), join(auth, '.credentials.json'));
    assert.throws(
      () => nativeAuthMounts('claude', auth, home, '/native/claude'),
      /missing or not a regular file/,
    );
  });
  withDirs((auth, home) => {
    callerHome(auth, '.credentials.json');
    mkdirSync(home);
    assert.throws(
      () => nativeAuthMounts('claude', auth, home, '/native/claude'),
      /EEXIST/,
    );
  });
  assert.deepEqual(nativeAuthMounts('opencode', '/x', '/y', '/z'), []);
  assert.throws(
    () => nativeAuthMounts('other', '/x', '/y', '/z'),
    /Unknown provider/,
  );
});

const jwt = (exp) =>
  ['h', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 's'].join(
    '.',
  );
const NOW = 1_800_000_000_000;
const RUN = 82 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('a Claude token that would refresh during the run refuses the launch', () => {
  withDirs((auth) => {
    const write = (expiresAt) =>
      writeFileSync(
        join(auth, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { expiresAt } }),
      );
    write(NOW + 6 * HOUR);
    assertCredentialsOutliveRun('claude', auth, RUN, NOW);
    write(NOW + 90 * 60 * 1000);
    assert.throws(
      () => assertCredentialsOutliveRun('claude', auth, RUN, NOW),
      /claude login refreshes at .* inside this review/,
    );
    writeFileSync(join(auth, '.credentials.json'), '{}');
    assert.throws(
      () => assertCredentialsOutliveRun('claude', auth, RUN, NOW),
      /no readable expiry/,
    );
  });
});

test('a Codex token that would expire, or reach its 8-day refresh, during the run refuses the launch', () => {
  withDirs((auth) => {
    const write = (expMs, lastRefreshMs) =>
      writeFileSync(
        join(auth, 'auth.json'),
        JSON.stringify({
          tokens: { access_token: jwt(expMs / 1000) },
          last_refresh: new Date(lastRefreshMs).toISOString(),
        }),
      );
    write(NOW + 8 * DAY, NOW - 2 * DAY);
    assertCredentialsOutliveRun('codex', auth, RUN, NOW);
    // Access token about to expire.
    write(NOW + HOUR, NOW - 2 * DAY);
    assert.throws(
      () => assertCredentialsOutliveRun('codex', auth, RUN, NOW),
      /codex login refreshes at/,
    );
    // Token still valid for days, but last_refresh crosses 8 days mid-run.
    write(NOW + 2 * DAY, NOW - 8 * DAY + HOUR);
    assert.throws(
      () => assertCredentialsOutliveRun('codex', auth, RUN, NOW),
      /codex login refreshes at/,
    );
    writeFileSync(join(auth, 'auth.json'), JSON.stringify({ tokens: {} }));
    assert.throws(
      () => assertCredentialsOutliveRun('codex', auth, RUN, NOW),
      /no readable expiry/,
    );
    // Antigravity's token is used read-only and never refreshed here.
    assertCredentialsOutliveRun('agy', auth, RUN, NOW);
    assert.equal(existsSync(join(auth, '.credentials.json')), false);
  });
});
