/* eslint-disable vitest/no-import-node-test -- the image build runs this test without Vitest installed. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('package bins are installed from the manifest, not dependency shims', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'repo-tools-bins-test-'));
  try {
    const source = join(fixture, 'package');
    const bin = join(fixture, 'bin');
    mkdirSync(source);
    mkdirSync(bin);
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({ bin: { 'repo-require-worktree': 'guard.sh' } }),
    );
    const guard = join(source, 'guard.sh');
    writeFileSync(guard, '#!/bin/sh\nexit 0\n');
    chmodSync(guard, 0o755);
    const run = (mode) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./repo-tools-bins.mjs', import.meta.url)),
          mode,
          source,
          bin,
        ],
        { encoding: 'utf8', timeout: 30000 },
      );
    // Reproduce the broken image: a dangling literal glob link is no install.
    symlinkSync(join(source, 'node_modules/.bin/repo-*'), join(bin, 'repo-*'));
    assert.notEqual(run('verify').status, 0);
    assert.equal(run('install').status, 0);
    // Executable presence alone is insufficient: a fail-open guard fails setup.
    assert.notEqual(run('verify').status, 0);
    writeFileSync(guard, '#!/bin/sh\nexit 1\n');
    assert.notEqual(run('verify').status, 0);
    // Healthy fixture distinguishes the real linked and primary Git layouts.
    writeFileSync(
      guard,
      '#!/bin/sh\n[ "$(git rev-parse --git-dir)" != ".git" ]\n',
    );
    assert.equal(run('verify').status, 0);
    rmSync(join(bin, 'repo-require-worktree'));
    chmodSync(guard, 0o644);
    assert.notEqual(run('install').status, 0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
