import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { protectedConfigMounts } from './review-auth-mounts.mjs';

function withAuthDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'review-auth-mounts-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('existing Claude hook registrations are overlaid read-only at the container path', () => {
  withAuthDir((auth) => {
    writeFileSync(join(auth, 'settings.json'), '{}\n');
    writeFileSync(join(auth, '.credentials.json'), '{}\n');
    assert.deepEqual(protectedConfigMounts('claude', auth, '/native/claude'), [
      '--mount',
      `type=bind,source=${join(auth, 'settings.json')},target=/native/claude/settings.json,readonly`,
    ]);
  });
});

test('Codex hooks.json is protected in place; absent files add no mount', () => {
  withAuthDir((auth) => {
    assert.deepEqual(protectedConfigMounts('codex', auth, auth), []);
    writeFileSync(join(auth, 'hooks.json'), '{}\n');
    assert.deepEqual(protectedConfigMounts('codex', auth, auth), [
      '--mount',
      `type=bind,source=${join(auth, 'hooks.json')},target=${join(auth, 'hooks.json')},readonly`,
    ]);
  });
});

test('a registration that is not a regular file refuses the launch', () => {
  withAuthDir((auth) => {
    mkdirSync(join(auth, 'real'));
    writeFileSync(join(auth, 'real', 'settings.json'), '{}\n');
    symlinkSync(
      join(auth, 'real', 'settings.json'),
      join(auth, 'settings.json'),
    );
    assert.throws(
      () => protectedConfigMounts('claude', auth, '/native/claude'),
      /not a regular file/,
    );
  });
});

test('providers without a writable auth directory need no overlay', () => {
  assert.deepEqual(protectedConfigMounts('opencode', '/unused', '/unused'), []);
  assert.deepEqual(protectedConfigMounts('agy', '/unused', '/unused'), []);
  assert.throws(
    () => protectedConfigMounts('other', '/x', '/x'),
    /Unknown provider/,
  );
});
