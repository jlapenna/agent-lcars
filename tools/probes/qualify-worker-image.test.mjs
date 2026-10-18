// Behavioral coverage for the in-runner qualification seams: real small
// subprocesses in owned scratch. Passing fixtures never claim to qualify a
// real provider suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { artifactHashes } from './qualification-evidence.mjs';
import {
  bakedInputMap,
  consumerHashes,
  executeInRunnerPhases,
  hashFile,
  hostScenarioArgs,
  hostVersionArgs,
  indexRoot,
  superviseInRunnerRun,
} from './qualify-worker-image.mjs';

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

// --- in-runner lifecycle seams ------------------------------------------------

const repoSource = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function syntheticAllocation() {
  const imageId = 'sha256:' + 'a'.repeat(64);
  const contract = {
    provider: 'codex',
    imageId,
    sourceCommit: 'b'.repeat(40),
    providerVersion: '9.9.9',
    bakedHashes: Object.fromEntries(
      Object.keys(bakedInputMap(repoSource)).map((name) => [
        name,
        'c'.repeat(64),
      ]),
    ),
    probeHashes: artifactHashes(repoSource).probeHashes,
    consumerHashes: consumerHashes(repoSource),
  };
  const receipt = {
    provider: 'codex',
    imageId,
    runId: 'run-claim-1',
    uid: 1001,
    hostname: hostname(),
    arch: process.arch,
    cpuCores: 2,
    memoryBytes: 6 * 1024 * 1024 * 1024,
    startedAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  return { imageId, contract, receipt };
}

function supervisorDeps(spawns) {
  const { receipt } = syntheticAllocation();
  return {
    readRunFacts: () => ({
      uid: receipt.uid,
      hostname: receipt.hostname,
      arch: receipt.arch,
      cpuCores: receipt.cpuCores,
      memoryBytes: receipt.memoryBytes,
      nowMs: Date.now(),
    }),
    artifactHashes,
    hashFile,
    spawnChild: (runRoot) => {
      spawns.push(runRoot);
      return {
        pid: 4242,
        birth: { procStarttime: '12345' },
        wait: async () => ({ code: 0, signal: null }),
      };
    },
  };
}

test('the exclusive run-root claim is deterministic and single-entry', async () => {
  const root = ownedScratch();
  const output = join(root, 'out');
  const { receipt, contract } = syntheticAllocation();
  const receiptPath = join(root, 'receipt.json');
  const contractPath = join(root, 'contract.json');
  writeFileSync(receiptPath, JSON.stringify(receipt));
  writeFileSync(contractPath, JSON.stringify(contract));
  const spawns = [];
  const deps = supervisorDeps(spawns);
  const first = await superviseInRunnerRun(
    { provider: 'codex', receiptPath, contractPath, outputPath: output },
    deps,
  );
  assert.equal(first.claimed, true);
  assert.equal(spawns.length, 1);
  assert.ok(existsSync(join(first.runRoot, 'intent.json')));
  const child = JSON.parse(
    readFileSync(join(first.runRoot, 'child.json'), 'utf8'),
  );
  assert.equal(child.pid, 4242);
  assert.equal(child.birth.procStarttime, '12345');
  // A status re-read after the child failed cannot start another entry.
  writeFileSync(
    join(first.runRoot, 'status.json'),
    JSON.stringify({ exitCode: 1 }),
  );
  const rerun = await superviseInRunnerRun(
    { provider: 'codex', receiptPath, contractPath, outputPath: output },
    deps,
  );
  assert.equal(rerun.claimed, false);
  assert.equal(rerun.exitCode, 1);
  assert.equal(spawns.length, 1);
  // Transport ambiguity: a claimed run with no status still never respawns.
  rmSync(join(first.runRoot, 'status.json'));
  const ambiguous = await superviseInRunnerRun(
    { provider: 'codex', receiptPath, contractPath, outputPath: output },
    deps,
  );
  assert.equal(ambiguous.claimed, false);
  assert.equal(ambiguous.exitCode, 1);
  assert.equal(ambiguous.status, null);
  assert.equal(spawns.length, 1);
});

test('a mismatched allocation is refused before any claim', async () => {
  const root = ownedScratch();
  const { receipt, contract } = syntheticAllocation();
  const receiptPath = join(root, 'receipt.json');
  const contractPath = join(root, 'contract.json');
  writeFileSync(
    receiptPath,
    JSON.stringify({ ...receipt, uid: 0, hostname: 'elsewhere' }),
  );
  writeFileSync(contractPath, JSON.stringify(contract));
  const spawns = [];
  await assert.rejects(
    superviseInRunnerRun(
      {
        provider: 'codex',
        receiptPath,
        contractPath,
        outputPath: join(root, 'out'),
      },
      supervisorDeps(spawns),
    ),
    /uid-not-runner.*hostname-mismatch/s,
  );
  assert.equal(spawns.length, 0);
});

function preparedRunRoot() {
  const root = ownedScratch();
  const runRoot = join(root, 'run-1');
  mkdirSync(runRoot);
  mkdirSync(join(runRoot, 'logs'));
  mkdirSync(join(runRoot, 'fixtures'));
  mkdirSync(join(runRoot, 'retained'));
  const { contract, imageId } = syntheticAllocation();
  writeFileSync(
    join(runRoot, 'intent.json'),
    JSON.stringify({
      provider: 'codex',
      runId: 'run-1',
      imageId,
      providerClock: {
        startedAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
      receiptSha: 'd'.repeat(64),
      contractSha: 'e'.repeat(64),
      artifactHashes: artifactHashes(repoSource),
    }),
  );
  writeFileSync(join(runRoot, 'contract.json'), JSON.stringify(contract));
  return runRoot;
}

const ok = (stdout, code = 0) => ({
  code,
  stdout,
  stderr: '',
  timedOut: false,
  diagnostics: { durationMs: 5 },
  recording: { error: null },
});

function phaseDeps({
  native = ok('{"observations":[]}'),
  runRoot = '/unused',
} = {}) {
  return {
    collectBakedInputs: () => ({ roots: [], captured: [] }),
    evaluate: () => ({ offlinePassed: true, failures: [] }),
    runProcess: async (binary, args, cwd, env, timeout, recording) => {
      if (binary === '/bin/bash') return ok('/usr/local/bin/codex\n9.9.9\n');
      if (args.some((a) => String(a).includes('vitest')))
        return ok('consumer ok');
      if (args.some((a) => String(a) === 'setup-negative'))
        return ok(JSON.stringify({ observations: [{ mode: 'x' }] }));
      if (args.some((a) => String(a).includes('in-runner-image'))) {
        if (native === 'fixtures-then-garbage') {
          writeFileSync(join(runRoot, 'fixtures/kept.txt'), 'kept');
          writeFileSync(join(recording.stdoutPath), 'not-json-at-all');
          native = ok('not-json-at-all');
        }
        return native;
      }
      return ok('');
    },
  };
}

test('a malformed report stops at first failure and retains all partial data', async () => {
  const runRoot = preparedRunRoot();
  const exitCode = await executeInRunnerPhases(
    runRoot,
    phaseDeps({ native: 'fixtures-then-garbage', runRoot }),
  );
  assert.equal(exitCode, 1);
  const qualification = JSON.parse(
    readFileSync(join(runRoot, 'qualification.json'), 'utf8'),
  );
  assert.equal(qualification.localProbePassed, false);
  assert.equal(qualification.durableCollectionComplete, false);
  assert.equal(qualification.qualificationAccepted, false);
  assert.equal(qualification.cleanupAuthorized, false);
  assert.equal(qualification.graduated, false);
  assert.equal(qualification.activationAuthorized, false);
  assert.match(qualification.stopped, /malformed-report: native/);
  assert.equal(
    readFileSync(join(runRoot, 'logs/native.stdout.bin'), 'utf8'),
    'not-json-at-all',
  );
  assert.equal(qualification.offlineEvaluation, null);
  const phases = JSON.parse(readFileSync(join(runRoot, 'phases.json'), 'utf8'));
  assert.deepEqual(
    phases.phases.map((entry) => entry.phase),
    ['version', 'native'],
  );
  assert.equal(existsSync(join(runRoot, 'setup-negative.report.json')), false);
  assert.equal(
    readFileSync(join(runRoot, 'fixtures/kept.txt'), 'utf8'),
    'kept',
  );
  assert.equal(
    JSON.parse(readFileSync(join(runRoot, 'status.json'), 'utf8')).exitCode,
    1,
  );
});

test('phase metadata records invocation, deadline, exit, and env keys only', async () => {
  const runRoot = preparedRunRoot();
  await executeInRunnerPhases(runRoot, phaseDeps());
  const phases = JSON.parse(readFileSync(join(runRoot, 'phases.json'), 'utf8'));
  const names = phases.phases.map((entry) => entry.phase);
  assert.deepEqual(names, [
    'version',
    'native',
    'setup-negative',
    'failure-consumer',
  ]);
  const native = phases.phases.find((entry) => entry.phase === 'native');
  assert.deepEqual(native.envKeys, [
    'HOME',
    'LCARS_PROBE_KEEP_EVIDENCE',
    'PATH',
    'TMPDIR',
  ]);
  assert.ok(native.args.includes(join(runRoot, 'fixtures')) === false);
  assert.ok(native.deadlineMs > 0 && native.deadlineMs <= 50 * 60000);
  const qualification = JSON.parse(
    readFileSync(join(runRoot, 'qualification.json'), 'utf8'),
  );
  assert.equal(qualification.localProbePassed, true);
  assert.equal(
    JSON.parse(readFileSync(join(runRoot, 'status.json'), 'utf8')).exitCode,
    0,
  );
});

test('root indexing keeps links as pointers and never follows external targets', () => {
  const root = ownedScratch();
  const inside = join(root, 'fixtures');
  mkdirSync(inside);
  writeFileSync(join(root, 'report.json'), '{}');
  symlinkSync(join(root, 'report.json'), join(inside, 'owned-link'));
  symlinkSync('/etc/passwd', join(inside, 'outside-link'));
  symlinkSync(
    '/opt/agent-tools/bin/worker-policy.cjs',
    join(inside, 'baked-link'),
  );
  const index = indexRoot(root, { retainedRoots: ['/opt/agent-tools'] });
  const byPath = Object.fromEntries(index.entries.map((e) => [e.path, e]));
  assert.equal(byPath['fixtures/owned-link'].type, 'link');
  assert.equal(byPath['fixtures/owned-link'].owned, true);
  assert.equal(byPath['fixtures/outside-link'].retained, false);
  assert.equal(byPath['fixtures/baked-link'].retained, true);
  assert.equal(index.retention, 'incomplete');
  assert.deepEqual(
    index.externalPointers.map((p) => p.path),
    ['fixtures/baked-link', 'fixtures/outside-link'],
  );
  const file = byPath['report.json'];
  assert.equal(file.role, 'report');
  assert.ok(Number.isSafeInteger(file.ino) && Number.isSafeInteger(file.uid));
});

test('the preserved host Docker argument route stays byte-identical', () => {
  assert.deepEqual(hostVersionArgs('sha256:' + 'a'.repeat(64), 'codex'), [
    '--network',
    'none',
    '--user',
    '1001:1001',
    '--cpus',
    '2',
    '--memory',
    '2g',
    '--pids-limit',
    '256',
    '--entrypoint',
    '/bin/bash',
    'sha256:' + 'a'.repeat(64),
    '-c',
    'command -v "$1"; "$1" --version',
    'qualification-version',
    'codex',
  ]);
  const args = hostScenarioArgs(
    '/src',
    'img',
    'claude',
    '/bin/claude',
    'v1',
    'setup-negative',
  );
  assert.ok(
    args.includes('-e') && args.includes('LCARS_PROBE_KEEP_EVIDENCE=1'),
  );
  assert.ok(
    args.includes(
      'type=bind,src=' +
        join('/src', 'packages/fleet-tools/bin') +
        ',dst=/qualification/packages/fleet-tools/bin,readonly',
    ),
  );
  const driverIndex = args.indexOf(
    '/qualification/tools/probes/in-runner-image.mjs',
  );
  assert.ok(driverIndex > 0);
  assert.deepEqual(args.slice(driverIndex + 1), [
    'claude',
    '/bin/claude',
    'v1',
    'img',
    'setup-negative',
  ]);
});

test('both CLI usages fail closed without touching Docker', () => {
  const cli = join(repoSource, 'tools/probes/qualify-worker-image.mjs');
  const host = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(host.status, 1);
  assert.match(host.stderr, /usage: qualify-worker-image\.mjs <provider>/);
  const runner = spawnSync(process.execPath, [cli, '--in-runner', 'codex'], {
    encoding: 'utf8',
  });
  assert.equal(runner.status, 1);
  assert.match(runner.stderr, /--in-runner <provider>/);
});
