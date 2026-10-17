// Safety invariant for #2848: a task-owned dockerd must never start in the
// host network namespace, where it deletes or rewires the production docker0.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

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
