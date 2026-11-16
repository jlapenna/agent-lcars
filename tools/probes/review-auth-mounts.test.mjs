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

test('Claude gets a private home with only its credential bound read-write', () => {
  withDirs((auth, home) => {
    callerHome(auth, '.credentials.json');
    assert.deepEqual(nativeAuthMounts('claude', auth, home, '/native/claude'), [
      '--mount',
      `type=bind,source=${home},target=/native/claude`,
      '--mount',
      `type=bind,source=${join(auth, '.credentials.json')},target=/native/claude/.credentials.json`,
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

test('a Codex access token that would expire during the run refuses the launch', () => {
  withDirs((auth) => {
    const now = 1_800_000_000_000;
    const runMs = 82 * 60 * 1000;
    const write = (exp) =>
      writeFileSync(
        join(auth, 'auth.json'),
        JSON.stringify({ tokens: { access_token: jwt(exp) } }),
      );
    write(now / 1000 + 8 * 24 * 3600);
    assertCredentialsOutliveRun('codex', auth, runMs, now);
    write(now / 1000 + 60 * 60);
    assert.throws(
      () => assertCredentialsOutliveRun('codex', auth, runMs, now),
      /expires before this review could finish/,
    );
    writeFileSync(join(auth, 'auth.json'), JSON.stringify({ tokens: {} }));
    assert.throws(
      () => assertCredentialsOutliveRun('codex', auth, runMs, now),
      /expires before/,
    );
    // Claude rotates its own credential in place; nothing to check.
    assertCredentialsOutliveRun('claude', auth, runMs, now);
    assert.equal(existsSync(join(auth, '.credentials.json')), false);
  });
});
