// Behavioral coverage for the in-runner qualification seams: real small
// subprocesses in owned scratch. Passing fixtures never claim to qualify a
// real provider suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNativeProcess } from './native-process.mjs';
import { driverEnvironment } from './in-runner-image.mjs';

function ownedScratch() {
  const root = mkdtempSync(join(tmpdir(), 'lcars-qual-test-'));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('recording keeps every emitted byte while the tail bound stays', async () => {
  const root = ownedScratch();
  const recording = {
    stdoutPath: join(root, 'out.bin'),
    stderrPath: join(root, 'err.bin'),
  };
  const result = await runNativeProcess(
    process.execPath,
    [
      '-e',
      "process.stdout.write('a'.repeat(1200000));process.stderr.write('b'.repeat(1100000));",
    ],
    root,
    { PATH: process.env.PATH },
    30000,
    recording,
  );
  assert.equal(result.code, 0);
  assert.equal(result.recording.error, null);
  assert.equal(result.recording.stdoutBytes, 1200000);
  assert.equal(result.recording.stderrBytes, 1100000);
  assert.equal(result.stdout.length, 1000000);
  assert.equal(readFileSync(recording.stdoutPath).length, 1200000);
  assert.equal(readFileSync(recording.stderrPath).length, 1100000);
});

test('recorded output files are exclusive and owned', async () => {
  const root = ownedScratch();
  const recording = {
    stdoutPath: join(root, 'out.bin'),
    stderrPath: join(root, 'err.bin'),
  };
  await runNativeProcess(
    process.execPath,
    ['-e', 'console.log(1)'],
    root,
    { PATH: process.env.PATH },
    30000,
    recording,
  );
  assert.equal(statSync(recording.stdoutPath).mode & 0o777, 0o600);
});

test('an existing recording path refuses success', async () => {
  const root = ownedScratch();
  const stdoutPath = join(root, 'out.bin');
  writeFileSync(stdoutPath, 'occupied');
  const result = await runNativeProcess(
    process.execPath,
    ['-e', 'console.log(1)'],
    root,
    { PATH: process.env.PATH },
    30000,
    { stdoutPath, stderrPath: join(root, 'err.bin') },
  );
  assert.equal(result.code, null);
  assert.match(result.recording.error, /recording-open-failed/);
});

test('a cap overflow refuses success', async () => {
  const root = ownedScratch();
  const result = await runNativeProcess(
    process.execPath,
    ['-e', "process.stdout.write('a'.repeat(1000))"],
    root,
    { PATH: process.env.PATH },
    30000,
    {
      stdoutPath: join(root, 'out.bin'),
      stderrPath: join(root, 'err.bin'),
      maxBytes: 100,
    },
  );
  assert.equal(result.code, 0);
  assert.match(result.recording.error, /recording-cap-exceeded/);
});

test('a child leaving an inherited pipe open stays bounded and non-success', async () => {
  const root = ownedScratch();
  const started = Date.now();
  const result = await runNativeProcess(
    process.execPath,
    [
      '-e',
      "require('child_process').spawn('sleep',['2'],{stdio:'inherit'});console.log('marker');process.exit(0)",
    ],
    root,
    { PATH: process.env.PATH },
    500,
    { stdoutPath: join(root, 'out.bin'), stderrPath: join(root, 'err.bin') },
  );
  assert.ok(Date.now() - started < 8000);
  assert.equal(result.timedOut, true);
  // A printed answer is not completion: the timeout flag outranks the exit
  // code, so the qualification caller's success predicate stays false.
  assert.equal(result.code === 0 && !result.timedOut, false);
  assert.equal(result.recording.error, null);
  assert.equal(readFileSync(join(root, 'out.bin'), 'utf8'), 'marker\n');
});

test('the default pipe path stays recording-free', async () => {
  const result = await runNativeProcess(
    process.execPath,
    ['-e', 'console.log("plain")'],
    process.cwd(),
    { PATH: process.env.PATH },
    30000,
  );
  assert.equal(result.code, 0);
  assert.equal(result.recording, undefined);
  assert.equal(result.stdout.trim(), 'plain');
});

test('driverEnvironment forwards the owned TMPDIR and retention only when set', () => {
  const base = { PATH: '/p', HOME: '/h' };
  assert.deepEqual(driverEnvironment(base, 'codex'), base);
  assert.deepEqual(
    driverEnvironment({ ...base, TMPDIR: '/run/fixtures' }, 'claude'),
    {
      ...base,
      TMPDIR: '/run/fixtures',
    },
  );
  assert.deepEqual(
    driverEnvironment(
      { ...base, LCARS_PROBE_KEEP_EVIDENCE: '1', TMPDIR: '/x' },
      'opencode',
    ),
    {
      ...base,
      TMPDIR: '/x',
      LCARS_PROBE_KEEP_EVIDENCE: '1',
      LCARS_PROBE_OPENCODE_DEPENDENCIES: '/home/runner/.config/opencode',
    },
  );
});

test('createProbeScratch roots under the forwarded owned TMPDIR', () => {
  const root = ownedScratch();
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      "import('./tools/probes/scratch.mjs').then((m)=>{const r=m.createProbeScratch('tmpdir-probe-');console.log(r)})".replace(
        './tools/probes/scratch.mjs',
        join(process.cwd(), 'tools/probes/scratch.mjs'),
      ),
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: root },
    },
  );
  assert.equal(probe.status, 0, probe.stderr);
  const created = probe.stdout.trim();
  assert.ok(created.startsWith(root));
  try {
    statSync(created);
    assert.fail('a passing scratch root must be removed');
  } catch (error) {
    assert.equal(error.code, 'ENOENT');
  }
  const kept = spawnSync(
    process.execPath,
    [
      '-e',
      'import(' +
        JSON.stringify(join(process.cwd(), 'tools/probes/scratch.mjs')) +
        ").then((m)=>{const r=m.createProbeScratch('tmpdir-keep-');console.log(r)})",
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: root,
        LCARS_PROBE_KEEP_EVIDENCE: '1',
      },
    },
  );
  assert.equal(kept.status, 0, kept.stderr);
  assert.ok(statSync(kept.stdout.trim()).isDirectory());
});
