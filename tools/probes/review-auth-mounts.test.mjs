import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  isWritableState,
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

// The layout observed in a real operator ~/.claude.
function claudeHome(auth) {
  for (const file of [
    '.credentials.json',
    '.claude.json',
    'history.jsonl',
    'settings.json',
    'statusline-command.sh',
    'policy-limits.json.signature.json',
  ])
    writeFileSync(join(auth, file), '{}\n');
  for (const dir of ['projects', 'sessions', 'cache', 'hooks', 'plugins'])
    mkdirSync(join(auth, dir));
  symlinkSync('../.agents/AGENTS.md', join(auth, 'CLAUDE.md'));
}

test('everything but Claude runtime state is overlaid read-only; symlinks are left to reconcile', () => {
  withAuthDir((auth) => {
    claudeHome(auth);
    const target = '/native/claude';
    assert.deepEqual(protectedConfigMounts('claude', auth, target), [
      ...readonly(join(auth, 'hooks'), `${target}/hooks`),
      ...readonly(join(auth, 'plugins'), `${target}/plugins`),
      ...readonly(join(auth, 'settings.json'), `${target}/settings.json`),
      ...readonly(
        join(auth, 'statusline-command.sh'),
        `${target}/statusline-command.sh`,
      ),
    ]);
  });
});

test('Codex keeps versioned state writable and protects its configuration in place', () => {
  withAuthDir((auth) => {
    for (const file of [
      'auth.json',
      'state_5.sqlite',
      'logs_2.sqlite-wal',
      'config.toml',
      'hooks.json',
      'lcars-hook.sh',
    ])
      writeFileSync(join(auth, file), '\n');
    for (const dir of ['sessions', 'shell_snapshots', 'rules', 'plugins'])
      mkdirSync(join(auth, dir));
    assert.deepEqual(protectedConfigMounts('codex', auth, auth), [
      ...readonly(join(auth, 'config.toml'), join(auth, 'config.toml')),
      ...readonly(join(auth, 'hooks.json'), join(auth, 'hooks.json')),
      ...readonly(join(auth, 'lcars-hook.sh'), join(auth, 'lcars-hook.sh')),
      ...readonly(join(auth, 'plugins'), join(auth, 'plugins')),
      ...readonly(join(auth, 'rules'), join(auth, 'rules')),
    ]);
    assert.ok(isWritableState('codex', 'thread_history_1.sqlite-shm'));
    assert.ok(!isWritableState('codex', 'config.toml'));
  });
});

test('unsupported entry names and types refuse the launch; OpenCode binds no directory', () => {
  withAuthDir((auth) => {
    writeFileSync(join(auth, 'odd,name'), '\n');
    assert.throws(
      () => protectedConfigMounts('claude', auth, '/native/claude'),
      /Unsupported configuration entry name/,
    );
  });
  assert.deepEqual(protectedConfigMounts('opencode', '/unused', '/unused'), []);
  assert.deepEqual(snapshotRegistrations('opencode', '/unused'), {});
  assert.throws(() => snapshotRegistrations('other', '/x'), /Unknown provider/);
});

test('a configuration entry created during the run is moved aside; new runtime state is left alone', () => {
  withAuthDir((auth) => {
    claudeHome(auth);
    rmSync(join(auth, 'settings.json'));
    const before = snapshotRegistrations('claude', auth);
    assert.equal(before['settings.json'], null);
    const hook = '{"hooks":{"PreToolUse":[]}} # lcars-worker-pretool:v1\n';
    writeFileSync(join(auth, 'settings.json'), hook);
    // A live session creating its own new state must not be disturbed.
    writeFileSync(join(auth, 'some-new-state.json'), '{}\n');
    mkdirSync(join(auth, 'projects', 'live-session'));
    const aside = join(auth, 'settings.json.review-qualification-42');
    assert.deepEqual(reconcileRegistrations('claude', auth, before, 42), [
      { path: join(auth, 'settings.json'), change: 'created', movedTo: aside },
    ]);
    assert.equal(existsSync(join(auth, 'settings.json')), false);
    assert.equal(readFileSync(aside, 'utf8'), hook);
    assert.ok(existsSync(join(auth, 'some-new-state.json')));
  });
});

test('a replaced instruction symlink is restored and the replacement kept as evidence', () => {
  withAuthDir((auth) => {
    claudeHome(auth);
    const before = snapshotRegistrations('claude', auth);
    rmSync(join(auth, 'CLAUDE.md'));
    writeFileSync(join(auth, 'CLAUDE.md'), 'injected instructions\n');
    const aside = join(auth, 'CLAUDE.md.review-qualification-7');
    assert.deepEqual(reconcileRegistrations('claude', auth, before, 7), [
      {
        path: join(auth, 'CLAUDE.md'),
        change: 'symlink-replaced',
        restoredTarget: '../.agents/AGENTS.md',
        movedTo: aside,
      },
    ]);
    assert.equal(readlinkSync(join(auth, 'CLAUDE.md')), '../.agents/AGENTS.md');
    assert.equal(readFileSync(aside, 'utf8'), 'injected instructions\n');
  });
});

test('an unchanged directory reconciles cleanly; a modified protected file is reported, not touched', () => {
  withAuthDir((auth) => {
    claudeHome(auth);
    const before = snapshotRegistrations('claude', auth);
    writeFileSync(join(auth, 'history.jsonl'), 'live session history\n');
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
