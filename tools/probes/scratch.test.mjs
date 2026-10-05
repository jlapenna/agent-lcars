/* eslint-disable vitest/no-import-node-test -- Verify runs this dependency-free probe helper test directly with node --test. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { KEEP_EVIDENCE_ENV, retainsScratch } from './scratch.mjs';

const helper = fileURLToPath(new URL('./scratch.mjs', import.meta.url));

// Runs a tiny probe that creates its scratch root, writes evidence into it,
// prints the root, and finishes the way `ending` says.
function runProbe(ending, env = {}) {
  const script = `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { createProbeScratch } from ${JSON.stringify(helper)};
    const root = createProbeScratch('lcars-scratch-test-');
    writeFileSync(join(root, 'observations.json'), '{}');
    console.log(root);
    ${ending}
  `;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), ...env },
    },
  );
  return { ...result, root: result.stdout.trim().split('\n')[0] };
}

test('a passing probe removes its scratch root', () => {
  const result = runProbe('process.exitCode = 0;');
  assert.equal(result.status, 0);
  assert.equal(existsSync(result.root), false);
});

test('a failing probe keeps its scratch root and says where', () => {
  const result = runProbe('process.exitCode = 1;');
  try {
    assert.equal(result.status, 1);
    assert.equal(existsSync(join(result.root, 'observations.json')), true);
    assert.match(result.stderr, /probe evidence retained at /);
  } finally {
    rmSync(result.root, { recursive: true, force: true });
  }
});

test('an uncaught exception keeps the scratch root', () => {
  const result = runProbe("throw new Error('version mismatch');");
  try {
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(result.root), true);
  } finally {
    rmSync(result.root, { recursive: true, force: true });
  }
});

test('the keep-evidence opt-in keeps a passing root', () => {
  const result = runProbe('process.exitCode = 0;', {
    [KEEP_EVIDENCE_ENV]: '1',
  });
  try {
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(result.root, 'observations.json')), true);
  } finally {
    rmSync(result.root, { recursive: true, force: true });
  }
});

test('retention is decided by exit code and the opt-in only', () => {
  assert.equal(retainsScratch(0, {}), false);
  assert.equal(retainsScratch(1, {}), true);
  assert.equal(retainsScratch(0, { [KEEP_EVIDENCE_ENV]: '0' }), false);
  assert.equal(retainsScratch(0, { [KEEP_EVIDENCE_ENV]: '1' }), true);
});
