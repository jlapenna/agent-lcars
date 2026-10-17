// Safety invariant for #2848: a task-owned dockerd must never start in the
// host network namespace, where it deletes or rewires the production docker0.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ISOLATION_REFUSED, privateEngineCommand } from './private-engine.mjs';

test('daemon never starts when namespace isolation did not happen', () => {
  const root = mkdtempSync(join(tmpdir(), 'lcars-private-engine-test-'));
  try {
    const started = join(root, 'dockerd-started');
    // A daemon stand-in that records whether it was ever executed.
    const dockerd = join(root, 'dockerd');
    writeFileSync(dockerd, `#!/bin/sh\ntouch '${started}'\n`);
    chmodSync(dockerd, 0o755);
    // An unshare that silently fails to isolate: it just runs the command
    // after "--" in the caller's (host) namespaces.
    const unshare = join(root, 'unshare');
    writeFileSync(
      unshare,
      '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
    );
    chmodSync(unshare, 0o755);

    const [binary, ...args] = privateEngineCommand(join(root, 'engine'), {
      unshare,
      dockerd,
    });
    const result = spawnSync(binary, args, { encoding: 'utf8' });

    assert.equal(result.status, ISOLATION_REFUSED, result.stderr);
    assert.match(result.stderr, /refusing to start dockerd/);
    assert.equal(existsSync(started), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('launch requests fresh network and mount namespaces before dockerd', () => {
  const command = privateEngineCommand('/run/lcars-engine');
  const separator = command.indexOf('--');
  assert.equal(command[0], 'unshare');
  assert.ok(command.slice(1, separator).includes('--net'));
  assert.ok(command.slice(1, separator).includes('--mount'));
  assert.ok(command.indexOf('/usr/bin/dockerd') > separator);
});

test('retired CLI refuses before creating engine state or launching a child', () => {
  const root = mkdtempSync(join(tmpdir(), 'lcars-retired-engine-test-'));
  const engine = join(root, 'engine');
  try {
    const childAttempt = join(root, 'child-attempted');
    const blockChildren = join(root, 'block-children.cjs');
    writeFileSync(
      blockChildren,
      `const { writeFileSync } = require('node:fs');
const childProcess = require('node:child_process');
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[method] = () => {
    writeFileSync(${JSON.stringify(childAttempt)}, method);
    throw new Error('retired CLI attempted a child launch');
  };
}
require('node:module').syncBuiltinESMExports();
`,
    );
    const control = spawnSync(
      process.execPath,
      [
        '--require',
        blockChildren,
        '--input-type=module',
        '-e',
        "import { spawn } from 'node:child_process'; spawn('lcars-daemon-stand-in');",
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(control.status, 1, control.stderr);
    assert.equal(existsSync(childAttempt), true);
    rmSync(childAttempt);
    const direct = fileURLToPath(
      new URL('./private-engine.mjs', import.meta.url),
    );
    const linked = join(root, 'private-engine.mjs');
    symlinkSync(direct, linked);
    for (const script of [direct, linked]) {
      for (const args of [[], [engine], [root]]) {
        const result = spawnSync(
          process.execPath,
          ['--require', blockChildren, script, ...args],
          { encoding: 'utf8', timeout: 5000 },
        );
        assert.equal(result.status, ISOLATION_REFUSED, result.stderr);
        assert.match(result.stderr, /retired after #2848/);
        assert.equal(existsSync(engine), false);
        assert.equal(existsSync(join(root, 'daemon.json')), false);
        assert.equal(existsSync(childAttempt), false);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
