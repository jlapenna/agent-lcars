import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

// Each fixture is an auth directory with a sibling private-state root.
let privateRoot;
function withAuthDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'review-auth-mounts-'));
  const auth = join(dir, 'auth');
  privateRoot = join(dir, 'private');
  mkdirSync(auth);
  try {
    return fn(auth);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isolated = (target, ...names) =>
  names.flatMap((name) => [
    '--mount',
    `type=bind,source=${join(privateRoot, name)},target=${target}/${name}`,
  ]);

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

const CLAUDE = '/native/claude';
const claudeSessionState = () =>
  isolated(CLAUDE, 'projects', 'session-env', 'shell-snapshots');

test('everything but Claude runtime state is overlaid read-only; symlinks are left to reconcile', () => {
  withAuthDir((auth) => {
    claudeHome(auth);
    assert.deepEqual(
      protectedConfigMounts('claude', auth, CLAUDE, privateRoot),
      [
        ...readonly(join(auth, 'hooks'), `${CLAUDE}/hooks`),
        ...readonly(join(auth, 'plugins'), `${CLAUDE}/plugins`),
        ...readonly(join(auth, 'settings.json'), `${CLAUDE}/settings.json`),
        ...readonly(
          join(auth, 'statusline-command.sh'),
          `${CLAUDE}/statusline-command.sh`,
        ),
        ...claudeSessionState(),
      ],
    );
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
    for (const dir of ['sessions', 'rules', 'plugins'])
      mkdirSync(join(auth, dir));
    assert.deepEqual(protectedConfigMounts('codex', auth, auth, privateRoot), [
      ...readonly(join(auth, 'config.toml'), join(auth, 'config.toml')),
      ...readonly(join(auth, 'hooks.json'), join(auth, 'hooks.json')),
      ...readonly(join(auth, 'lcars-hook.sh'), join(auth, 'lcars-hook.sh')),
      ...readonly(join(auth, 'plugins'), join(auth, 'plugins')),
      ...readonly(join(auth, 'rules'), join(auth, 'rules')),
      ...isolated(auth, 'shell_snapshots'),
    ]);
    assert.ok(isWritableState('codex', 'thread_history_1.sqlite-shm'));
    assert.ok(!isWritableState('codex', 'config.toml'));
  });
});

test('sourced session state always gets an empty private overlay and requires a private root', () => {
  withAuthDir((auth) => {
    mkdirSync(join(auth, 'shell-snapshots'));
    writeFileSync(join(auth, 'shell-snapshots', 'live.sh'), 'export X=1\n');
    assert.throws(
      () => protectedConfigMounts('claude', auth, CLAUDE),
      /private state directory is required/,
    );
    // Nothing is created on the host when the launch is refused.
    assert.equal(existsSync(join(auth, 'session-env')), false);
    assert.deepEqual(
      protectedConfigMounts('claude', auth, CLAUDE, privateRoot),
      claudeSessionState(),
    );
    // An absent directory is created so the overlay still applies.
    assert.ok(existsSync(join(auth, 'session-env')));
    assert.ok(existsSync(join(privateRoot, 'shell-snapshots')));
    assert.equal(
      existsSync(join(privateRoot, 'shell-snapshots', 'live.sh')),
      false,
    );
  });
});

test('a configuration symlink resolving into a writable binding refuses the launch', () => {
  withAuthDir((auth) => {
    writeFileSync(join(auth, 'history.jsonl'), '\n');
    symlinkSync(join(auth, 'history.jsonl'), join(auth, 'settings.json'));
    assert.throws(
      () => protectedConfigMounts('claude', auth, CLAUDE, privateRoot),
      /resolves into a writable binding/,
    );
    // Dangling, or outside every writable binding: protected by reconcile.
    rmSync(join(auth, 'settings.json'));
    symlinkSync('../.agents/AGENTS.md', join(auth, 'CLAUDE.md'));
    assert.deepEqual(
      protectedConfigMounts('claude', auth, CLAUDE, privateRoot),
      claudeSessionState(),
    );
  });
});

test('unsupported entry names and types refuse the launch; OpenCode binds no directory', () => {
  withAuthDir((auth) => {
    writeFileSync(join(auth, 'odd,name'), '\n');
    assert.throws(
      () => protectedConfigMounts('claude', auth, CLAUDE, privateRoot),
      /Unsupported configuration entry name/,
    );
  });
  assert.deepEqual(protectedConfigMounts('opencode', '/unused', '/unused'), []);
  assert.deepEqual(snapshotRegistrations('opencode', '/unused'), {});
  assert.throws(() => snapshotRegistrations('other', '/x'), /Unknown provider/);
});

test('Claude projects/ (transcripts and per-project memory) is private to the review', () => {
  withAuthDir((auth) => {
    mkdirSync(join(auth, 'projects', '-home-op-p', 'memory'), {
      recursive: true,
    });
    writeFileSync(
      join(auth, 'projects', '-home-op-p', 'memory', 'MEMORY.md'),
      'live\n',
    );
    assert.deepEqual(
      protectedConfigMounts('claude', auth, CLAUDE, privateRoot),
      claudeSessionState(),
    );
    // The review starts from an empty projects/; the caller's memory is
    // neither visible nor reachable, including by renaming a parent.
    assert.deepEqual(readdirSync(join(privateRoot, 'projects')), []);
  });
});

test('missing SQLite sidecars of protected Codex databases are created empty and overlaid', () => {
  withAuthDir((auth) => {
    writeFileSync(join(auth, 'memories_1.sqlite'), 'db');
    writeFileSync(join(auth, 'memories_1.sqlite-wal'), 'live wal');
    writeFileSync(join(auth, 'state_5.sqlite'), 'db');
    const mounts = protectedConfigMounts('codex', auth, auth, privateRoot);
    for (const suffix of ['', '-journal', '-shm', '-wal'])
      assert.ok(
        mounts.includes(
          `type=bind,source=${join(auth, 'memories_1.sqlite' + suffix)},target=${join(auth, 'memories_1.sqlite' + suffix)},readonly`,
        ),
        suffix,
      );
    // An existing sidecar is never truncated; writable databases get none.
    assert.equal(
      readFileSync(join(auth, 'memories_1.sqlite-wal'), 'utf8'),
      'live wal',
    );
    assert.equal(readFileSync(join(auth, 'memories_1.sqlite-shm'), 'utf8'), '');
    assert.equal(existsSync(join(auth, 'state_5.sqlite-wal')), false);
  });
});

test('a symlink to a FIFO is snapshotted by its target without blocking', () => {
  withAuthDir((auth) => {
    const fifo = join(privateRoot, 'pipe');
    mkdirSync(privateRoot);
    execFileSync('mkfifo', [fifo]);
    symlinkSync(fifo, join(auth, 'CLAUDE.md'));
    assert.deepEqual(
      snapshotRegistrations('claude', auth).entries['CLAUDE.md'],
      {
        kind: 'symlink',
        target: fifo,
      },
    );
  });
});

test('Codex memories and goals stay protected; Antigravity cli.log is runtime state', () => {
  for (const name of [
    'memories_1.sqlite',
    'memories_1.sqlite-wal',
    'goals_1.sqlite',
  ])
    assert.ok(!isWritableState('codex', name), name);
  for (const name of ['state_5.sqlite-wal', 'queue_1.sqlite', '.tmpWgLsAh'])
    assert.ok(isWritableState('codex', name), name);
  assert.ok(isWritableState('agy', 'cli.log'));
  for (const name of ['security', 'remote', 'local', 'downloads'])
    assert.ok(!isWritableState('claude', name), name);
});

test('a configuration entry created during the run is moved aside and fails the run; new runtime state is left alone', () => {
  withAuthDir((auth) => {
    claudeHome(auth);
    rmSync(join(auth, 'settings.json'));
    const before = snapshotRegistrations('claude', auth);
    assert.equal(before.entries['settings.json'], null);
    const hook = '{"hooks":{"PreToolUse":[]}} # lcars-worker-pretool:v1\n';
    writeFileSync(join(auth, 'settings.json'), hook);
    // A live session creating its own new state must not be disturbed.
    writeFileSync(join(auth, 'some-new-state.json'), '{}\n');
    mkdirSync(join(auth, 'projects', 'live-session'));
    const aside = join(auth, 'settings.json.review-qualification-42');
    const findings = reconcileRegistrations('claude', auth, before, 42);
    assert.deepEqual(
      findings.map(({ path, change, movedTo, blocking }) => ({
        path,
        change,
        movedTo,
        blocking,
      })),
      [
        {
          path: join(auth, 'settings.json'),
          change: 'created',
          movedTo: aside,
          blocking: true,
        },
      ],
    );
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
    const [finding, ...rest] = reconcileRegistrations(
      'claude',
      auth,
      before,
      7,
    );
    assert.deepEqual(rest, []);
    assert.equal(finding.change, 'symlink-replaced');
    assert.equal(finding.movedTo, aside);
    assert.equal(finding.blocking, true);
    assert.equal(readlinkSync(join(auth, 'CLAUDE.md')), '../.agents/AGENTS.md');
    assert.equal(readFileSync(aside, 'utf8'), 'injected instructions\n');
  });
});

test('host-side changes to overlaid entries and symlink targets are reported without failing', () => {
  withAuthDir((auth) => {
    claudeHome(auth);
    const before = snapshotRegistrations('claude', auth);
    writeFileSync(join(auth, 'history.jsonl'), 'live session history\n');
    assert.deepEqual(reconcileRegistrations('claude', auth, before), []);
    writeFileSync(join(auth, 'settings.json'), '{"changed":true}\n');
    // homegit rewriting the file behind CLAUDE.md is not a link change.
    mkdirSync(join(auth, '..', '.agents'), { recursive: true });
    writeFileSync(join(auth, '..', '.agents', 'AGENTS.md'), 'edited on host\n');
    const findings = reconcileRegistrations('claude', auth, before);
    assert.deepEqual(
      findings.map(({ change, blocking }) => ({ change, blocking })),
      [{ change: 'modified', blocking: false }],
    );
    assert.equal(
      readFileSync(join(auth, 'settings.json'), 'utf8'),
      '{"changed":true}\n',
    );
  });
});

test('one entry failing to reconcile does not stop the others', () => {
  withAuthDir((auth) => {
    const before = {
      entries: { 'settings.json': null, 'keybindings.json': null },
      instructionDirectories: [],
    };
    // A directory where a file is expected makes the move-aside of this one
    // entry fail only if its aside path is occupied.
    writeFileSync(join(auth, 'settings.json'), '{}\n');
    mkdirSync(join(auth, 'settings.json.review-qualification-1'));
    writeFileSync(
      join(auth, 'settings.json.review-qualification-1', 'x'),
      '\n',
    );
    writeFileSync(join(auth, 'keybindings.json'), '{}\n');
    const findings = reconcileRegistrations('claude', auth, before, 1);
    assert.deepEqual(
      findings
        .map(({ change, blocking }) => ({ change, blocking }))
        .sort((a, b) => a.change.localeCompare(b.change)),
      [
        { change: 'created', blocking: true },
        { change: 'error', blocking: true },
      ],
    );
    assert.equal(existsSync(join(auth, 'keybindings.json')), false);
  });
});
