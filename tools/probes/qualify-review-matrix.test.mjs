import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Exercise the committed coordinator with local CLI outcomes, no Docker,
// authentication or inference. Native evidence semantics have separate tests.
function matrix(failedProvider, mutation = '') {
  const temporary = mkdtempSync(join(tmpdir(), 'lcars-review-matrix-'));
  try {
    const root = join(temporary, 'source');
    const probes = join(root, 'tools/probes');
    const bin = join(temporary, 'bin');
    const output = join(temporary, 'evidence');
    mkdirSync(probes, { recursive: true });
    mkdirSync(bin);
    copyFileSync(
      new URL('./qualify-review-matrix.mjs', import.meta.url),
      join(probes, 'qualify-review-matrix.mjs'),
    );
    const providers = ['claude', 'codex', 'opencode', 'agy'];
    writeFileSync(
      join(probes, 'review-cases.json'),
      JSON.stringify({
        providers,
        cases: ['first', 'unqualified-upstream-update', 'third'].map(
          (id, index) => ({
            id,
            pullRequest: 42,
            head: index === 0 ? 'candidate' : String(index).repeat(40),
          }),
        ),
      }),
    );
    // Git is only a read-only source identity precondition in this fixture.
    writeFileSync(
      join(bin, 'git'),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (JSON.stringify(args) === '["status","--porcelain"]') process.exit(0);
if (JSON.stringify(args) === '["rev-parse","HEAD"]') console.log('a'.repeat(40));
else process.exit(99);
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(probes, 'run-review-image.mjs'),
      `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [provider, , , output] = process.argv.slice(2);
const run = join(output, 'run');
mkdirSync(run, { recursive: true });
const mutation = process.env.FIXTURE_MUTATION;
const failed = provider === process.env.FIXTURE_FAILED_PROVIDER &&
  (!mutation.startsWith('control-') || output.endsWith('unqualified-upstream-update'));
writeFileSync(join(run, 'evaluation.json'), failed && mutation === 'evaluation-json'
  ? '{' : JSON.stringify({ passed: !failed }));
const receipt = {
  candidates: [{ id: 'C1', description: 'Renovate digest automerge bypasses qualification' }],
  validators: [{ candidateId: 'C1', decision: 'confirmed', evidence: 'Renovate digest automerge bypasses qualification' }],
};
if (failed && mutation === 'control-inventory') receipt.validators = {};
if (failed && mutation === 'control-null-item') receipt.validators = [null];
writeFileSync(join(run, 'receipt.json'), failed && mutation === 'receipt-json'
  ? '{' : JSON.stringify(receipt));
// Reproduce the missed exhausted-account shape: no recognized JSON error.
writeFileSync(join(run, 'native-evidence.json'), JSON.stringify({ providerFailure: null }));
if (failed) console.error('You’ve hit your weekly limit');
process.exitCode = failed ? 1 : 0;
`,
    );
    const execution = spawnSync(
      process.execPath,
      [
        join(probes, 'qualify-review-matrix.mjs'),
        '42',
        'sha256:' + 'b'.repeat(64),
        output,
      ],
      {
        cwd: root,
        env: {
          PATH: bin + ':' + process.env.PATH,
          HOME: process.env.HOME,
          FIXTURE_FAILED_PROVIDER: failedProvider ?? '',
          FIXTURE_MUTATION: mutation,
        },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    assert.equal(execution.error, undefined);
    return {
      exit: execution.status,
      result: JSON.parse(readFileSync(join(output, 'matrix.json'), 'utf8')),
      providers,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test('matrix stops a failed provider before more cases, while other providers finish', () => {
  const { exit, result, providers } = matrix('codex');
  assert.equal(exit, 1);
  assert.equal(result.complete, false);
  assert.equal(result.passed, false);
  const failed = result.results.filter((row) => row.provider === 'codex');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].case, 'first');
  assert.equal(failed[0].passed, false);
  assert.match(failed[0].execution.stderr, /weekly limit/);
  for (const provider of providers.filter((name) => name !== 'codex')) {
    const rows = result.results.filter((row) => row.provider === provider);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.passed));
  }
});

test('matrix acceptance still requires all three cases for all four providers', () => {
  const { exit, result } = matrix();
  assert.equal(exit, 0);
  assert.equal(result.complete, true);
  assert.equal(result.passed, true);
  assert.equal(result.results.length, 12);
});

for (const mutation of [
  'receipt-json',
  'evaluation-json',
  'control-inventory',
  'control-null-item',
]) {
  test(`matrix records ${mutation} failure without aborting sibling lanes`, () => {
    const { exit, result, providers } = matrix('codex', mutation);
    assert.equal(exit, 1);
    assert.equal(result.complete, false);
    assert.equal(result.passed, false);
    const failed = result.results.filter((row) => row.provider === 'codex');
    assert.equal(failed.length, mutation.startsWith('control-') ? 2 : 1);
    assert.equal(failed.at(-1).passed, false);
    if (mutation.endsWith('-json'))
      assert.match(
        failed.at(-1).outputErrors.join('\n'),
        /Invalid output.*\.json/,
      );
    else assert.equal(failed.at(-1).knownDefectDetected, false);
    for (const provider of providers.filter((name) => name !== 'codex')) {
      const rows = result.results.filter((row) => row.provider === provider);
      assert.equal(rows.length, 3);
      assert.ok(rows.every((row) => row.passed));
    }
  });
}
