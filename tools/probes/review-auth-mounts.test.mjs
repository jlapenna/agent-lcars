import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  protectedConfigMounts,
  reconcileRegistrations,
  snapshotRegistrations,
} from './review-auth-mounts.mjs';

function withAuthDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'review-auth-mounts-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const readonly = (source, target) => [
  '--mount',
  `type=bind,source=${source},target=${target},readonly`,
];

test('existing Claude registrations and hook scripts are overlaid read-only at the container path', () => {
  withAuthDir((auth) => {
    writeFileSync(join(auth, 'settings.json'), '{}\n');
    writeFileSync(join(auth, '.credentials.json'), '{}\n');
    mkdirSync(join(auth, 'hooks'));
    assert.deepEqual(protectedConfigMounts('claude', auth, '/native/claude'), [
      ...readonly(join(auth, 'settings.json'), '/native/claude/settings.json'),
      ...readonly(join(auth, 'hooks'), '/native/claude/hooks'),
    ]);
  });
});

test('Codex hooks.json is protected in place; absent entries add no mount', () => {
  withAuthDir((auth) => {
    assert.deepEqual(protectedConfigMounts('codex', auth, auth), []);
    writeFileSync(join(auth, 'hooks.json'), '{}\n');
    assert.deepEqual(
      protectedConfigMounts('codex', auth, auth),
      readonly(join(auth, 'hooks.json'), join(auth, 'hooks.json')),
    );
  });
});

test('a registration of the wrong kind refuses the launch', () => {
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
  withAuthDir((auth) => {
    writeFileSync(join(auth, 'hooks'), 'not a directory\n');
    assert.throws(
      () => protectedConfigMounts('claude', auth, '/native/claude'),
      /not a regular dir/,
    );
  });
});

test('providers without a writable auth directory need no overlay', () => {
  assert.deepEqual(protectedConfigMounts('opencode', '/unused', '/unused'), []);
  assert.deepEqual(protectedConfigMounts('agy', '/unused', '/unused'), []);
  assert.deepEqual(snapshotRegistrations('opencode', '/unused'), {});
  assert.throws(
    () => protectedConfigMounts('other', '/x', '/x'),
    /Unknown provider/,
  );
});

test('a registration created during the run is moved aside and reported', () => {
  withAuthDir((auth) => {
    const before = snapshotRegistrations('claude', auth);
    assert.deepEqual(before, {
      'settings.json': null,
      'settings.local.json': null,
    });
    const hook = '{"hooks":{"PreToolUse":[]}} # lcars-worker-pretool:v1\n';
    writeFileSync(join(auth, 'settings.json'), hook);
    const findings = reconcileRegistrations('claude', auth, before, 42);
    const aside = join(auth, 'settings.json.review-qualification-42');
    assert.deepEqual(findings, [
      { path: join(auth, 'settings.json'), change: 'created', movedTo: aside },
    ]);
    assert.equal(existsSync(join(auth, 'settings.json')), false);
    assert.equal(readFileSync(aside, 'utf8'), hook);
  });
});

test('unchanged registrations reconcile cleanly; a modified one is reported, not touched', () => {
  withAuthDir((auth) => {
    writeFileSync(join(auth, 'settings.json'), '{}\n');
    const before = snapshotRegistrations('claude', auth);
    assert.deepEqual(reconcileRegistrations('claude', auth, before), []);
    writeFileSync(join(auth, 'settings.json'), '{"changed":true}\n');
    assert.deepEqual(reconcileRegistrations('claude', auth, before), [
      { path: join(auth, 'settings.json'), change: 'modified' },
    ]);
    assert.equal(
      readFileSync(join(auth, 'settings.json'), 'utf8'),
      '{"changed":true}\n',
    );
  });
});
