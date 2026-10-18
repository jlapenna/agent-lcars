/* eslint-disable vitest/no-import-node-test -- Verify runs this probe helper test directly with node --test. */
// Behavioral coverage for the in-runner qualification seams: real small
// subprocesses in owned scratch. Passing fixtures never claim to qualify a
// real provider suite.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { driverEnvironment } from './in-runner-image.mjs';
import { runChildProcess, runNativeProcess } from './native-process.mjs';
import { artifactHashes } from './qualification-evidence.mjs';
import {
  admitProviderDeadline,
  allocationFailures,
  bakedInputMap,
  claimRunRoot,
  consumerHashes,
  defaultCollectBakedInputs,
  dirtyOwningInputFailures,
  executeInRunnerPhases,
  finalizeRun,
  hashFile,
  hostScenarioArgs,
  hostVersionArgs,
  indexRoot,
  PHASE_STREAM_MAX_BYTES,
  readMonotonicClock,
  runRootBasename,
  sourceDriftFailures,
  superviseInRunnerRun,
} from './qualify-worker-image.mjs';

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

const canonicalRunId = () => 'work:01M57H2E8XVTC6YJMPKEET8R7Z/r2';

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
    runId: canonicalRunId(),
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
      runId: receipt.runId,
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
  await assert.rejects(
    superviseInRunnerRun(
      { provider: 'codex', receiptPath, contractPath, outputPath: output },
      deps,
    ),
    /existing-run-unverified-or-incomplete/,
  );
  assert.equal(spawns.length, 1);
  // Transport ambiguity: a claimed run with no status is a refusal, not a
  // terminal failure journal or permission to respawn.
  rmSync(join(first.runRoot, 'status.json'));
  await assert.rejects(
    superviseInRunnerRun(
      { provider: 'codex', receiptPath, contractPath, outputPath: output },
      deps,
    ),
    /existing-run-unverified-or-incomplete/,
  );
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
      monotonicDeadline: admitProviderDeadline(
        { expiresAt: new Date(Date.now() + 3600000).toISOString() },
        Date.now(),
        readMonotonicClock(),
      ),
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

// Mirror the real recorder: emit every byte to the owned recording file and
// report it, so the child parses the complete recorded stdout, never a tail.
function emit(recording, stdout, code = 0) {
  if (recording?.stdoutPath) writeFileSync(recording.stdoutPath, stdout);
  if (recording?.stderrPath) writeFileSync(recording.stderrPath, '');
  return {
    code,
    stdout,
    stderr: '',
    timedOut: false,
    diagnostics: { durationMs: 5 },
    recording: {
      error: null,
      stdoutPath: recording?.stdoutPath,
      stderrPath: recording?.stderrPath,
      stdoutBytes: stdout.length,
      stderrBytes: 0,
    },
  };
}

function phaseDeps({
  native = JSON.stringify({ observations: [] }),
  runRoot = '/unused',
} = {}) {
  return {
    collectBakedInputs: () => ({ roots: [], captured: [] }),
    verifySourceContract: () => [],
    evaluate: () => ({ offlinePassed: true, failures: [] }),
    runProcess: async (binary, args, _cwd, _env, _timeout, recording) => {
      if (binary === '/bin/bash')
        return emit(recording, '/usr/bin/codex\n9.9.9\n');
      if (args.some((a) => String(a).includes('vitest')))
        return emit(recording, 'consumer ok');
      if (args.some((a) => String(a) === 'setup-negative'))
        return emit(
          recording,
          JSON.stringify({ observations: [{ mode: 'x' }] }),
        );
      if (args.some((a) => String(a).includes('in-runner-image'))) {
        if (native === 'fixtures-then-garbage') {
          writeFileSync(join(runRoot, 'fixtures/kept.txt'), 'kept');
          return emit(recording, 'not-json-at-all');
        }
        return emit(recording, native);
      }
      return emit(recording, '');
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
    ['setup', 'version', 'native'],
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
    'setup',
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

test('an unknown termination reports nested retirement unknown and retention incomplete', async () => {
  const killed = preparedRunRoot();
  const base = phaseDeps({ runRoot: killed });
  const exitCode = await executeInRunnerPhases(killed, {
    ...base,
    runProcess: async (binary, args, cwd, env, timeout, recording) => {
      if (args.some((a) => String(a).includes('in-runner-image'))) {
        // Killing the wrapper's group never certifies the provider group the
        // driver started inside it: no self-reported exit, partial bytes only.
        writeFileSync(join(killed, 'fixtures/live-writer.txt'), 'partial');
        writeFileSync(recording.stdoutPath, '{"obs');
        return {
          code: null,
          stdout: '{"obs',
          stderr: '',
          timedOut: true,
          diagnostics: { durationMs: 5, closeSignal: 'SIGKILL' },
          recording: {
            error: null,
            stdoutPath: recording.stdoutPath,
            stderrPath: recording.stderrPath,
            stdoutBytes: 5,
            stderrBytes: 0,
          },
        };
      }
      return base.runProcess(binary, args, cwd, env, timeout, recording);
    },
  });
  assert.equal(exitCode, 1);
  const qualification = JSON.parse(
    readFileSync(join(killed, 'qualification.json'), 'utf8'),
  );
  assert.equal(qualification.nestedRetirement, 'unknown');
  assert.ok(
    qualification.unknowns.includes('nested-retirement-unknown: native'),
    JSON.stringify(qualification.unknowns),
  );
  for (const flag of [
    'localProbePassed',
    'durableCollectionComplete',
    'qualificationAccepted',
    'cleanupAuthorized',
    'graduated',
    'activationAuthorized',
  ])
    assert.equal(qualification[flag], false, flag);
  const index = JSON.parse(readFileSync(join(killed, 'index.json'), 'utf8'));
  assert.equal(index.nestedRetirement, 'unknown');
  assert.equal(index.retention, 'incomplete');
  // Nothing is deleted on the way to that verdict.
  assert.equal(
    readFileSync(join(killed, 'fixtures/live-writer.txt'), 'utf8'),
    'partial',
  );
  assert.equal(
    readFileSync(join(killed, 'logs/native.stdout.bin'), 'utf8'),
    '{"obs',
  );
  // A phase that reported its own exit does not inherit the unknown verdict.
  const clean = preparedRunRoot();
  await executeInRunnerPhases(clean, phaseDeps({ runRoot: clean }));
  const cleanIndex = JSON.parse(
    readFileSync(join(clean, 'index.json'), 'utf8'),
  );
  assert.equal(cleanIndex.nestedRetirement, 'confirmed');
  assert.equal(cleanIndex.retention, 'complete');
});

test('fleet-tools directory pointers are retained only after copying the complete target', async () => {
  const root = ownedScratch();
  const toolsRoot = join(root, 'agent-tools');
  mkdirSync(join(toolsRoot, 'bin'), { recursive: true });
  writeFileSync(join(toolsRoot, 'bin/worker-policy.cjs'), 'policy');
  writeFileSync(join(toolsRoot, 'package.json'), '{"name":"fleet-tools"}');
  const inputs = {
    'worker-policy.cjs': ['/unused', join(toolsRoot, 'bin/worker-policy.cjs')],
  };
  const contract = {
    bakedHashes: {
      'worker-policy.cjs': hashFile(inputs['worker-policy.cjs'][1]),
    },
  };
  const runRoot = preparedRunRoot();
  symlinkSync(toolsRoot, join(runRoot, 'fixtures/fleet-tools'));
  assert.equal(indexRoot(runRoot).retention, 'incomplete');
  const deps = phaseDeps();
  deps.collectBakedInputs = () =>
    defaultCollectBakedInputs(contract, runRoot, { inputs, toolsRoot });
  assert.equal(await executeInRunnerPhases(runRoot, deps), 0);
  const index = JSON.parse(readFileSync(join(runRoot, 'index.json')));
  assert.equal(index.retention, 'complete');
  assert.equal(index.externalPointers[0].retained, true);
  for (const path of ['bin/worker-policy.cjs', 'package.json'])
    assert.deepEqual(
      readFileSync(join(runRoot, 'retained/fleet-tools', path)),
      readFileSync(join(toolsRoot, path)),
    );

  symlinkSync('/unretained-target', join(toolsRoot, 'outside-link'));
  const externalRoot = preparedRunRoot();
  const external = defaultCollectBakedInputs(contract, externalRoot, {
    inputs,
    toolsRoot,
  });
  const externalIndex = indexRoot(externalRoot, {
    retainedRoots: external.roots,
  });
  assert.equal(externalIndex.retention, 'incomplete');
  assert.equal(
    externalIndex.externalPointers.find(
      (pointer) => pointer.path === 'retained/fleet-tools/outside-link',
    ).retained,
    false,
  );

  const failedRoot = preparedRunRoot();
  symlinkSync(toolsRoot, join(failedRoot, 'fixtures/fleet-tools'));
  const failedDeps = phaseDeps();
  failedDeps.collectBakedInputs = () =>
    defaultCollectBakedInputs(contract, failedRoot, {
      inputs,
      toolsRoot: join(root, 'missing-target'),
    });
  failedDeps.runProcess = () => assert.fail('no phase after failed retention');
  assert.equal(await executeInRunnerPhases(failedRoot, failedDeps), 1);
  const failedIndex = JSON.parse(readFileSync(join(failedRoot, 'index.json')));
  assert.equal(failedIndex.retention, 'incomplete');
  assert.equal(failedIndex.externalPointers[0].retained, false);
});

test('unknown nested retirement cannot certify retention even when every pointer is retained', () => {
  const root = ownedScratch();
  mkdirSync(join(root, 'fixtures'));
  symlinkSync(
    '/opt/agent-tools/bin/worker-policy.cjs',
    join(root, 'fixtures/baked-link'),
  );
  const retained = { retainedRoots: ['/opt/agent-tools'] };
  assert.equal(indexRoot(root, retained).retention, 'complete');
  const unknown = indexRoot(root, { ...retained, nestedRetirement: 'unknown' });
  assert.equal(unknown.retention, 'incomplete');
  assert.equal(unknown.externalPointers[0].retained, true);
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

test('the canonical run id is bound to the current run and a safe run root', () => {
  const runId = canonicalRunId();
  const actual = {
    uid: 1001,
    hostname: hostname(),
    arch: process.arch,
    runId,
    cpuCores: 2,
    memoryBytes: 6 * 1024 * 1024 * 1024,
    nowMs: Date.now(),
  };
  const { contract, receipt } = syntheticAllocation();
  const sourceHashes = artifactHashes(repoSource);
  assert.deepEqual(
    allocationFailures({
      provider: 'codex',
      receipt,
      contract,
      actual,
      sourceHashes,
    }),
    [],
  );
  assert.ok(
    allocationFailures({
      provider: 'codex',
      receipt: { ...receipt, runId: 'not-a-work-run' },
      contract,
      actual: { ...actual, runId: 'not-a-work-run' },
      sourceHashes,
    }).includes('receipt-run-id-not-canonical'),
  );
  assert.ok(
    allocationFailures({
      provider: 'codex',
      receipt,
      contract,
      actual: { ...actual, runId: canonicalRunId() + 'x' },
      sourceHashes,
    }).includes('run-id-not-bound'),
  );
  const output = ownedScratch();
  const claimed = claimRunRoot(output, runId);
  assert.match(basename(claimed.runRoot), /^run-[0-9a-f]{32}$/);
  assert.ok(!basename(claimed.runRoot).includes('/'));
});

test('unknown or wrong actual allocation values fail closed', () => {
  const { contract, receipt } = syntheticAllocation();
  const actual = {
    uid: 1001,
    hostname: hostname(),
    arch: process.arch,
    runId: canonicalRunId(),
    cpuCores: null,
    memoryBytes: null,
    nowMs: Date.now(),
  };
  const failures = allocationFailures({
    provider: 'codex',
    receipt,
    contract,
    actual,
    sourceHashes: artifactHashes(repoSource),
  });
  assert.ok(failures.includes('cgroup-cpu-actual'));
  assert.ok(failures.includes('cgroup-memory-actual'));
});

test('a failing setup phase stops before the version and probe phases', async () => {
  const runRoot = preparedRunRoot();
  const base = phaseDeps();
  const code = await executeInRunnerPhases(runRoot, {
    ...base,
    runProcess: async (...call) =>
      call[1].some((arg) => String(arg).includes('setup-worktree.sh'))
        ? emit(call[5], 'setup boom', 7)
        : base.runProcess(...call),
  });
  assert.equal(code, 1);
  assert.deepEqual(
    JSON.parse(readFileSync(join(runRoot, 'phases.json'), 'utf8')).phases.map(
      (phase) => phase.phase,
    ),
    ['setup'],
  );
  assert.match(
    JSON.parse(readFileSync(join(runRoot, 'qualification.json'), 'utf8'))
      .stopped,
    /setup-phase-failed/,
  );
});

test('source drift is caught before any probe phase', async () => {
  const runRoot = preparedRunRoot();
  const base = phaseDeps();
  const code = await executeInRunnerPhases(runRoot, {
    ...base,
    verifySourceContract: () => ['source-head-drift'],
  });
  assert.equal(code, 1);
  assert.deepEqual(
    JSON.parse(readFileSync(join(runRoot, 'phases.json'), 'utf8')).phases,
    [],
  );
  assert.match(
    JSON.parse(readFileSync(join(runRoot, 'qualification.json'), 'utf8'))
      .stopped,
    /source-drift: source-head-drift/,
  );
});

test('source drift compares HEAD and every source-side baked input', () => {
  const wanted = Object.keys(bakedInputMap(repoSource));
  const contract = {
    sourceCommit: 'a'.repeat(40),
    bakedHashes: Object.fromEntries(
      wanted.map((name) => [name, 'c'.repeat(64)]),
    ),
  };
  const hash = (path) => {
    const entry = Object.entries(bakedInputMap(repoSource)).find(
      ([, [sourcePath]]) => sourcePath === path,
    );
    return entry ? contract.bakedHashes[entry[0]] : null;
  };
  assert.deepEqual(
    sourceDriftFailures(contract, {
      readHead: () => 'a'.repeat(40),
      hash,
      dirty: () => [],
    }),
    [],
  );
  assert.ok(
    sourceDriftFailures(contract, {
      readHead: () => 'b'.repeat(40),
      hash,
      dirty: () => [],
    }).includes('source-head-drift'),
  );
  assert.ok(
    sourceDriftFailures(contract, {
      readHead: () => null,
      hash,
      dirty: () => [],
    }).includes('source-head-unavailable'),
  );
  assert.ok(
    sourceDriftFailures(contract, {
      readHead: () => 'a'.repeat(40),
      hash: () => 'd'.repeat(64),
      dirty: () => [],
    }).includes('source-input-drift: ' + wanted[0]),
  );
});

function git(repo, args) {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: repo },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('Git rejects transitive setup changes and accepts only restored source', () => {
  const root = ownedScratch();
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'tools'), { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'probe@example.invalid']);
  git(repo, ['config', 'user.name', 'probe']);
  writeFileSync(
    join(repo, 'tools/setup-worktree.sh'),
    '#!/bin/bash\nsource tools/nx-native-file-cache.sh\npnpm install\n',
  );
  const transitive = join(repo, 'tools/nx-native-file-cache.sh');
  const original =
    '#!/bin/bash\nexport NX_NATIVE_FILE_CACHE_DIRECTORY=/tmp/nx\n';
  writeFileSync(transitive, original);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  const contract = {
    sourceCommit: git(repo, ['rev-parse', 'HEAD']).trim(),
    bakedHashes: Object.fromEntries(
      Object.entries(bakedInputMap(repoSource)).map(([name, [path]]) => [
        name,
        hashFile(path),
      ]),
    ),
  };
  // Evidence is created after the exclusive claim, before the source check.
  const runRoot = join(repo, 'qualification-runs/run-owned');
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(join(runRoot, 'intent.json'), '{}');
  const seam = {
    readHead: () => contract.sourceCommit,
    hash: hashFile,
    dirty: () => dirtyOwningInputFailures({ cwd: repo, runRoot }),
  };
  assert.deepEqual(sourceDriftFailures(contract, seam), []);
  writeFileSync(transitive, original + 'echo changed\n');
  assert.deepEqual(sourceDriftFailures(contract, seam), [
    'owning-input-dirty: tools/nx-native-file-cache.sh',
  ]);
  git(repo, ['add', 'tools/nx-native-file-cache.sh']);
  assert.deepEqual(sourceDriftFailures(contract, seam), [
    'owning-input-dirty: tools/nx-native-file-cache.sh',
  ]);
  git(repo, [
    'restore',
    '--source=HEAD',
    '--staged',
    '--worktree',
    '--',
    'tools',
  ]);
  assert.deepEqual(sourceDriftFailures(contract, seam), []);
  // A previously unlisted install hook must be committed too.
  const untracked = join(repo, '.pnpmfile.cjs');
  writeFileSync(untracked, 'module.exports = { hooks: {} };\n');
  assert.deepEqual(sourceDriftFailures(contract, seam), [
    'owning-input-dirty: .pnpmfile.cjs',
  ]);
  rmSync(untracked);
  git(repo, ['rm', '-q', 'tools/nx-native-file-cache.sh']);
  assert.deepEqual(sourceDriftFailures(contract, seam), [
    'owning-input-dirty: tools/nx-native-file-cache.sh',
  ]);
  git(repo, [
    'restore',
    '--source=HEAD',
    '--staged',
    '--worktree',
    '--',
    'tools',
  ]);
  assert.deepEqual(sourceDriftFailures(contract, seam), []);
  // The exemption is not permission to stage evidence or other source.
  git(repo, ['add', 'qualification-runs']);
  assert.deepEqual(sourceDriftFailures(contract, seam), [
    'owning-input-dirty: qualification-runs/run-owned/intent.json',
  ]);
});

test('an unavailable or malformed Git status refuses the run', () => {
  for (const output of [null, undefined, '?? unterminated'])
    assert.deepEqual(dirtyOwningInputFailures({ status: () => output }), [
      'owning-inputs-status-unavailable',
    ]);
});

test('a spawn error and close settle the recording sink exactly once', async () => {
  const root = ownedScratch();
  const recording = {
    stdoutPath: join(root, 'spawn.stdout.bin'),
    stderrPath: join(root, 'spawn.stderr.bin'),
  };
  const result = await runNativeProcess(
    join(root, 'not-a-real-binary'),
    [],
    root,
    { PATH: process.env.PATH },
    1000,
    recording,
  );
  assert.equal(result.code, null);
  assert.equal(result.diagnostics.spawnError, 'ENOENT');
  assert.equal(result.recording.error, null);
  assert.equal(readFileSync(recording.stdoutPath, 'utf8'), '');
  assert.equal(readFileSync(recording.stderrPath, 'utf8'), '');
});

// Bounded recorder seam: real exclusive files and real descriptors, with only
// writeSync/closeSync wrapped so the original defects (return value ignored,
// non-idempotent close) are forced rather than assumed.
function countedIo(overrides = {}) {
  const closes = [];
  const opened = [];
  return {
    closes,
    opened,
    io: {
      openSync(path, flag, mode) {
        const fd = openSync(path, flag, mode);
        opened.push({ path, fd });
        return fd;
      },
      closeSync(fd) {
        closes.push(fd);
        closeSync(fd);
      },
      ...overrides,
    },
  };
}

test('a forced partial write still records every byte exactly once', async () => {
  const root = ownedScratch();
  const stdoutPath = join(root, 'partial.stdout.bin');
  const writes = [];
  const { closes, opened, io } = countedIo({
    // Commit one byte per call: a byte-count-blind recorder would count the
    // whole chunk while only the first byte ever reached the file.
    writeSync(fd, chunk, offset = 0) {
      writes.push(offset);
      return writeSync(fd, chunk, offset, 1);
    },
  });
  const result = await runChildProcess(
    { spawn, io },
    process.execPath,
    ['-e', "process.stdout.write('abcdefghij')"],
    root,
    { PATH: process.env.PATH },
    10000,
    { stdoutPath, stderrPath: join(root, 'partial.stderr.bin') },
  );
  assert.equal(result.code, 0);
  assert.equal(result.recording.error, null);
  assert.equal(result.recording.stdoutBytes, 10);
  assert.equal(readFileSync(stdoutPath, 'utf8'), 'abcdefghij');
  assert.deepEqual(writes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(result.stdout, 'abcdefghij');
  assert.deepEqual(
    [...closes].sort((a, b) => a - b),
    opened.map((entry) => entry.fd).sort((a, b) => a - b),
  );
  assert.equal(opened.length, 2);
});

test('a zero-progress write is refused instead of counted as recorded', async () => {
  const root = ownedScratch();
  const stdoutPath = join(root, 'stalled.stdout.bin');
  let calls = 0;
  const { closes, io } = countedIo({
    writeSync(...args) {
      calls += 1;
      assert.equal(args[2], 0);
      return 0;
    },
  });
  const result = await runChildProcess(
    { spawn, io },
    process.execPath,
    ['-e', "process.stdout.write('never-recorded')"],
    root,
    { PATH: process.env.PATH },
    10000,
    { stdoutPath, stderrPath: join(root, 'stalled.stderr.bin') },
  );
  assert.equal(calls, 1);
  assert.equal(result.recording.error, 'recording-write-stalled: stdout');
  assert.equal(result.recording.stdoutBytes, 0);
  assert.equal(readFileSync(stdoutPath, 'utf8'), '');
  // Success is refused at the caller predicate, not merely reported.
  assert.equal(result.code === 0 && result.recording.error === null, false);
  assert.equal(new Set(closes).size, 2);
});

test('a throwing write keeps the partial bytes and reports the exact fault', async () => {
  const root = ownedScratch();
  const stdoutPath = join(root, 'throwing.stdout.bin');
  const { io } = countedIo({
    writeSync(fd, chunk, offset = 0) {
      if (offset > 0)
        throw Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
        });
      return writeSync(fd, chunk, offset, 2);
    },
  });
  const result = await runChildProcess(
    { spawn, io },
    process.execPath,
    ['-e', "process.stdout.write('abcdefghijkl')"],
    root,
    { PATH: process.env.PATH },
    10000,
    { stdoutPath, stderrPath: join(root, 'throwing.stderr.bin') },
  );
  assert.equal(
    result.recording.error,
    'recording-write-failed: ENOSPC: no space left on device',
  );
  assert.equal(result.recording.stdoutBytes, 2);
  assert.equal(readFileSync(stdoutPath, 'utf8'), 'ab');
});

test('error then close settles once and closes each descriptor once', async () => {
  const root = ownedScratch();
  const { closes, io } = countedIo();
  const settlements = [];
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new Readable({
    read() {
      // This spawn-error fixture never produces stream data.
    },
  });
  child.stderr = new Readable({
    read() {
      // This spawn-error fixture never produces stream data.
    },
  });
  const result = await runChildProcess(
    {
      io,
      spawn: () => {
        queueMicrotask(() => {
          child.emit('error', new Error('spawn EPIPE'));
          child.emit('close', 0, null);
        });
        return child;
      },
    },
    'ignored',
    [],
    root,
    { PATH: process.env.PATH },
    10000,
    {
      stdoutPath: join(root, 'once.stdout.bin'),
      stderrPath: join(root, 'once.stderr.bin'),
    },
  );
  settlements.push(result);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].diagnostics.spawnError, 'unknown');
  assert.equal(settlements[0].code, null);
  // One settlement means one close pass: two closes per descriptor is the
  // original double-close defect.
  assert.equal(closes.length, 2);
  assert.equal(new Set(closes).size, 2);
});

test('a successful scenario is parsed from the complete record, not its tail', async () => {
  const runRoot = preparedRunRoot();
  const report = JSON.stringify({
    observations: [],
    pad: 'x'.repeat(1_000_005),
  });
  assert.ok(report.length > 1_000_000);
  const base = phaseDeps({ native: report, runRoot });
  const code = await executeInRunnerPhases(runRoot, {
    ...base,
    runProcess: async (...call) => {
      const result = await base.runProcess(...call);
      const args = call[1];
      if (
        args.some((arg) => String(arg).includes('in-runner-image')) &&
        !args.some((arg) => String(arg) === 'setup-negative')
      ) {
        result.stdout = result.stdout.slice(1);
        assert.throws(() => JSON.parse(result.stdout));
      }
      return result;
    },
  });
  assert.equal(code, 0);
  assert.equal(
    readFileSync(join(runRoot, 'logs/native.stdout.bin'), 'utf8'),
    report,
  );
});

for (const wallStep of [-86400000, 86400000]) {
  test(`admitted budget survives wall step ${wallStep} and charges child startup`, async () => {
    const root = ownedScratch();
    const { receipt, contract } = syntheticAllocation();
    const wall = Date.now();
    receipt.expiresAt = new Date(wall + 20000).toISOString();
    const receiptPath = join(root, 'receipt.json');
    const contractPath = join(root, 'contract.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(contractPath, JSON.stringify(contract));
    const bootId = readMonotonicClock().bootId;
    let mono = 100000;
    const readClock = () => ({ bootId, nowMs: mono });
    const originalNow = Date.now;
    const budgets = [];
    const base = phaseDeps();
    const supervisor = supervisorDeps([]);
    let runRoot;
    try {
      const result = await superviseInRunnerRun(
        {
          provider: 'codex',
          receiptPath,
          contractPath,
          outputPath: join(root, 'out'),
        },
        {
          ...supervisor,
          readMonotonicClock: readClock,
          readRunFacts: () => ({ ...supervisor.readRunFacts(), nowMs: wall }),
          spawnChild: (path) => {
            runRoot = path;
            // Real handoff seam: admission has already serialized its deadline.
            // Child startup costs five seconds; neither process renews the budget.
            mono += 5000;
            Date.now = () => wall + wallStep;
            return {
              pid: 4242,
              birth: {},
              wait: async () => ({
                code: await executeInRunnerPhases(path, {
                  ...base,
                  readMonotonicClock: readClock,
                  evaluate: (...args) => {
                    mono += 1000;
                    return base.evaluate(...args);
                  },
                  runProcess: async (...args) => {
                    budgets.push(args[4]);
                    assert.equal(args[5].maxBytes, 64 * 1024 * 1024);
                    mono += 1000;
                    return base.runProcess(...args);
                  },
                }),
              }),
            };
          },
        },
      );
      assert.equal(result.exitCode, 0);
      assert.deepEqual(budgets, [15000, 14000, 13000, 12000, 10000]);
      const intent = JSON.parse(readFileSync(join(runRoot, 'intent.json')));
      assert.equal(intent.monotonicDeadline.deadlineMs, 120000);
    } finally {
      Date.now = originalNow;
    }
  });
}

test('expired or invalid transferred clocks refuse before any phase and retain failure evidence', async () => {
  const clock = readMonotonicClock();
  assert.throws(
    () =>
      admitProviderDeadline(
        { expiresAt: new Date(1000).toISOString() },
        1000,
        clock,
      ),
    /expired/,
  );
  assert.throws(
    () => admitProviderDeadline({ expiresAt: 'invalid' }, 1000, clock),
    /invalid/,
  );
  assert.throws(
    () =>
      admitProviderDeadline(
        { expiresAt: new Date(2000).toISOString() },
        NaN,
        clock,
      ),
    /invalid/,
  );
  for (const change of [
    { nowMs: 2000 },
    { nowMs: 999 },
    { bootId: '00000000-0000-0000-0000-000000000000' },
    { nowMs: NaN },
  ]) {
    const runRoot = preparedRunRoot();
    const path = join(runRoot, 'intent.json');
    const intent = JSON.parse(readFileSync(path));
    intent.monotonicDeadline = {
      bootId: clock.bootId,
      admittedAtMs: 1000,
      deadlineMs: 2000,
    };
    writeFileSync(path, JSON.stringify(intent));
    let calls = 0;
    const code = await executeInRunnerPhases(runRoot, {
      ...phaseDeps(),
      readMonotonicClock: () => ({
        bootId: clock.bootId,
        nowMs: 1000,
        ...change,
      }),
      runProcess: async () => {
        calls++;
        throw new Error('must not spawn');
      },
    });
    assert.equal(code, 1);
    assert.equal(calls, 0);
    const phases = JSON.parse(readFileSync(join(runRoot, 'phases.json')));
    assert.match(phases.stopped, /provider-clock-(expired|invalid)/);
    assert.deepEqual(phases.phases, []);
    assert.equal(
      JSON.parse(readFileSync(join(runRoot, 'qualification.json')))
        .qualificationAccepted,
      false,
    );
  }
});

for (const overflowStream of ['stdout', 'stderr']) {
  test(`production setup ${overflowStream} cap preserves exact prefix and stops the lifecycle on overflow`, async () => {
    const runRoot = preparedRunRoot();
    let calls = 0;
    const code = await executeInRunnerPhases(runRoot, {
      ...phaseDeps(),
      runProcess: async (_binary, _args, cwd, env, timeout, recording) => {
        calls++;
        assert.equal(recording.maxBytes, PHASE_STREAM_MAX_BYTES);
        assert.equal(recording.maxBytes, 64 * 1024 * 1024);
        // Exercise the actual recorder with production options, without setup or
        // provider execution. Keep the other stream quiet to avoid pipe-order assumptions.
        const result = await runNativeProcess(
          process.execPath,
          [
            '-e',
            `
        const fs = require('node:fs');
        const chunk = Buffer.alloc(1024 * 1024, 120);
        for (let i = 0; i < 65; i++) {
          let offset = 0;
          while (offset < chunk.length) {
            offset += fs.writeSync(${overflowStream === 'stdout' ? 1 : 2}, chunk, offset, chunk.length - offset);
          }
        }
      `,
          ],
          cwd,
          env,
          timeout,
          recording,
        );
        assert.equal(result.code, 0);
        assert.equal(result.timedOut, false);
        assert.equal(
          result.recording.error,
          `recording-cap-exceeded: ${overflowStream}`,
        );
        return result;
      },
    });
    assert.equal(code, 1);
    assert.equal(calls, 1);
    const phases = JSON.parse(readFileSync(join(runRoot, 'phases.json')));
    assert.equal(phases.stopped, 'setup-phase-failed');
    assert.equal(phases.phases.length, 1);
    assert.equal(
      phases.phases[0].recording.error,
      `recording-cap-exceeded: ${overflowStream}`,
    );
    for (const stream of ['stdout', 'stderr']) {
      const bytes = readFileSync(join(runRoot, 'logs', `setup.${stream}.bin`));
      if (stream === overflowStream) {
        assert.ok(bytes.length > 0 && bytes.length <= PHASE_STREAM_MAX_BYTES);
        assert.equal(bytes.equals(Buffer.alloc(bytes.length, 120)), true);
      } else {
        assert.equal(bytes.length, 0);
      }
      assert.equal(phases.phases[0].recording[`${stream}Bytes`], bytes.length);
      const index = JSON.parse(readFileSync(join(runRoot, 'index.json')));
      assert.ok(
        index.entries.some(
          (entry) =>
            entry.path === `logs/setup.${stream}.bin` &&
            entry.size === bytes.length,
        ),
      );
    }
    const qualification = JSON.parse(
      readFileSync(join(runRoot, 'qualification.json')),
    );
    for (const key of [
      'localProbePassed',
      'durableCollectionComplete',
      'qualificationAccepted',
      'cleanupAuthorized',
      'graduated',
      'activationAuthorized',
    ])
      assert.equal(qualification[key], false);
    assert.ok(
      qualification.unknowns.includes(
        'partial-run: phases after the stop were never attempted',
      ),
    );
    assert.equal(
      JSON.parse(readFileSync(join(runRoot, 'status.json'))).exitCode,
      1,
    );
  });
}

test('elapsed monotonic budget stops later phases and cannot become a late success', async () => {
  for (const expireAt of [1, 4, 5]) {
    const runRoot = preparedRunRoot();
    const path = join(runRoot, 'intent.json');
    const intent = JSON.parse(readFileSync(path));
    const bootId = readMonotonicClock().bootId;
    intent.monotonicDeadline = {
      bootId,
      admittedAtMs: 1000,
      deadlineMs: 21000,
    };
    writeFileSync(path, JSON.stringify(intent));
    let nowMs = 1000;
    let calls = 0;
    const base = phaseDeps();
    const code = await executeInRunnerPhases(runRoot, {
      ...base,
      readMonotonicClock: () => ({ bootId, nowMs }),
      runProcess: async (...args) => {
        calls++;
        const result = await base.runProcess(...args);
        if (calls === expireAt) nowMs = 21000;
        return result;
      },
    });
    assert.equal(code, 1);
    assert.equal(calls, expireAt);
    const qualification = JSON.parse(
      readFileSync(join(runRoot, 'qualification.json')),
    );
    assert.equal(qualification.stopped, 'provider-clock-expired');
    assert.equal(qualification.localProbePassed, false);
    assert.equal(qualification.cleanupAuthorized, false);
  }
});

// Drive the real supervisor claim, child journal and finalizer over real files.
// Only provider phase execution/evaluation is synthetic; no qualification runs.
async function completedRun({ failure = false } = {}) {
  const root = ownedScratch();
  const { receipt, contract } = syntheticAllocation();
  const receiptPath = join(root, 'receipt.json');
  const contractPath = join(root, 'contract.json');
  writeFileSync(receiptPath, JSON.stringify(receipt));
  writeFileSync(contractPath, JSON.stringify(contract));
  const spawns = [];
  const deps = supervisorDeps(spawns);
  deps.spawnChild = (path) => {
    spawns.push(path);
    return {
      pid: 4242,
      birth: { procStarttime: '12345' },
      wait: async () => ({
        code: await executeInRunnerPhases(
          path,
          phaseDeps(
            failure ? { native: 'fixtures-then-garbage', runRoot: path } : {},
          ),
        ),
      }),
    };
  };
  const args = {
    provider: 'codex',
    receiptPath,
    contractPath,
    outputPath: join(root, 'out'),
  };
  const result = await superviseInRunnerRun(args, deps);
  assert.equal(result.exitCode, failure ? 1 : 0);
  return {
    root,
    args,
    deps,
    spawns,
    runRoot: result.runRoot,
    receipt,
    contract,
  };
}

for (const failure of [false, true]) {
  test(`matching completed ${failure ? 'failed' : 'passing'} run rereads without another child or deadline renewal`, async () => {
    const run = await completedRun({ failure });
    const intent = readFileSync(join(run.runRoot, 'intent.json'));
    const result = await superviseInRunnerRun(run.args, run.deps);
    assert.equal(result.claimed, false);
    assert.equal(result.exitCode, failure ? 1 : 0);
    assert.equal(run.spawns.length, 1);
    assert.deepEqual(readFileSync(join(run.runRoot, 'intent.json')), intent);
  });
}

// A rejected reread must not modify, adopt or clean the original evidence.
function snapshot(root) {
  const entries = [];
  function walk(path) {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name);
      const stat = lstatSync(file);
      entries.push([
        file,
        stat.ino,
        stat.uid,
        stat.mode,
        stat.size,
        stat.isFile() ? readFileSync(file).toString('base64') : null,
      ]);
      if (stat.isDirectory()) walk(file);
    }
  }
  walk(root);
  return entries;
}

const editJson = (path, change) => {
  const value = JSON.parse(readFileSync(path));
  change(value);
  writeFileSync(path, JSON.stringify(value));
};

const rereadMutations = {
  'current provider drift': (r) => {
    r.args.provider = 'claude';
    editJson(r.args.receiptPath, (o) => {
      o.provider = 'claude';
    });
    editJson(r.args.contractPath, (o) => {
      o.provider = 'claude';
    });
  },
  'stored run identity drift': (r) =>
    editJson(join(r.runRoot, 'intent.json'), (o) => {
      o.runId += 'other';
    }),
  'current actual run drift': (r) => {
    const facts = r.deps.readRunFacts;
    r.deps.readRunFacts = () => ({
      ...facts(),
      runId: canonicalRunId() + 'other',
    });
  },
  'current immutable image drift': (r) => {
    editJson(r.args.receiptPath, (o) => {
      o.imageId = 'sha256:' + 'f'.repeat(64);
    });
    editJson(r.args.contractPath, (o) => {
      o.imageId = 'sha256:' + 'f'.repeat(64);
    });
  },
  'current allocation receipt drift': (r) =>
    editJson(r.args.receiptPath, (o) => {
      o.allocation = 'different';
    }),
  'current source contract drift': (r) =>
    editJson(r.args.contractPath, (o) => {
      o.sourceCommit = 'f'.repeat(40);
    }),
  'current contract baked input drift': (r) =>
    editJson(r.args.contractPath, (o) => {
      o.bakedHashes[Object.keys(o.bakedHashes)[0]] = 'f'.repeat(64);
    }),
  'current harness input drift': (r) => {
    const hashes = r.deps.artifactHashes(repoSource);
    r.deps.artifactHashes = () => ({
      ...hashes,
      probeHashes: { ...hashes.probeHashes, unexpected: 'f'.repeat(64) },
    });
  },
  'copied receipt mismatch': (r) =>
    editJson(join(r.runRoot, 'receipt.json'), (o) => {
      o.allocation = 'different';
    }),
  'symlinked journal': (r) => {
    const original = join(r.runRoot, 'intent.json');
    renameSync(original, join(r.root, 'foreign-intent.json'));
    symlinkSync(join(r.root, 'foreign-intent.json'), original);
  },
  'symlinked completion': (r) => {
    const original = join(r.runRoot, 'status.json');
    renameSync(original, join(r.root, 'foreign-status.json'));
    symlinkSync(join(r.root, 'foreign-status.json'), original);
  },
  'malformed journal': (r) =>
    writeFileSync(join(r.runRoot, 'phases.json'), '{'),
  'missing journal': (r) => rmSync(join(r.runRoot, 'phases.json')),
  'unfinished journal with status zero': (r) =>
    editJson(join(r.runRoot, 'phases.json'), (o) => {
      o.phases.pop();
    }),
  'failed journal with status zero': (r) =>
    editJson(join(r.runRoot, 'phases.json'), (o) => {
      o.phases[0].exitCode = 1;
    }),
  'contradictory qualification': (r) =>
    editJson(join(r.runRoot, 'qualification.json'), (o) => {
      o.localProbePassed = false;
    }),
  'malformed terminal status': (r) =>
    writeFileSync(join(r.runRoot, 'status.json'), '{'),
  'missing terminal status': (r) => rmSync(join(r.runRoot, 'status.json')),
  'status byte drift at identical length': (r) => {
    const file = join(r.runRoot, 'status.json');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('exitCode":0', 'exitCode":1'),
    );
  },
  'index identity mismatch': (r) =>
    editJson(join(r.runRoot, 'index.json'), (o) => {
      o.entries.find((e) => e.path === 'status.json').ino++;
    }),
  'symlinked existing run root': (r) => {
    const foreign = join(r.root, 'foreign-root');
    renameSync(r.runRoot, foreign);
    symlinkSync(foreign, r.runRoot);
  },
};
for (const [name, mutate] of Object.entries(rereadMutations)) {
  test(`completed reread refuses ${name} and preserves evidence without spawning`, async () => {
    const r = await completedRun();
    mutate(r);
    const before = snapshot(r.root);
    await assert.rejects(
      superviseInRunnerRun(r.args, r.deps),
      /refused|existing-run-unverified/,
    );
    assert.equal(r.spawns.length, 1);
    assert.deepEqual(snapshot(r.root), before);
  });
}

test('status-zero-only precreated root cannot be adopted', async () => {
  const root = ownedScratch();
  const { receipt, contract } = syntheticAllocation();
  const receiptPath = join(root, 'receipt.json');
  const contractPath = join(root, 'contract.json');
  writeFileSync(receiptPath, JSON.stringify(receipt));
  writeFileSync(contractPath, JSON.stringify(contract));
  const outputPath = join(root, 'out');
  mkdirSync(outputPath);
  const runRoot = join(outputPath, runRootBasename(receipt.runId));
  mkdirSync(runRoot);
  writeFileSync(join(runRoot, 'status.json'), '{"exitCode":0}');
  const before = snapshot(root);
  const spawns = [];
  await assert.rejects(
    superviseInRunnerRun(
      { provider: 'codex', receiptPath, contractPath, outputPath },
      supervisorDeps(spawns),
    ),
    /existing-run-unverified/,
  );
  assert.equal(spawns.length, 0);
  assert.deepEqual(snapshot(root), before);
});

test('a real directory owned by another caller UID refuses completed reuse', async (t) => {
  const r = await completedRun();
  const uid = lstatSync(r.runRoot).uid;
  // Simulate the caller identity only; the filesystem metadata remains real.
  // No privileged chown or skipped ownership test is required on UID 1001 CI.
  t.mock.method(process, 'getuid', () => uid + 1);
  await assert.rejects(
    superviseInRunnerRun(r.args, r.deps),
    /run-artifact-not-owned-regular/,
  );
  assert.equal(r.spawns.length, 1);
});

test('final completion inventory matches both real finalized objects and status bytes', async () => {
  const r = await completedRun();
  const index = JSON.parse(readFileSync(join(r.runRoot, 'index.json')));
  const actual = indexRoot(r.runRoot);
  assert.deepEqual(
    index.entries,
    actual.entries.sort((a, b) => a.path.localeCompare(b.path, 'en')),
  );
  for (const name of ['index.json', 'status.json']) {
    const entry = index.entries.find((e) => e.path === name);
    const stat = lstatSync(join(r.runRoot, name));
    assert.deepEqual(
      [entry.ino, entry.uid, entry.mode, entry.size],
      [stat.ino, stat.uid, stat.mode & 0o777, stat.size],
    );
  }
  assert.equal(
    index.entries.find((e) => e.path === 'status.json').sha256,
    hashFile(join(r.runRoot, 'status.json')),
  );
  assert.equal(index.selfContentHash, 'excluded:index.json');
  assert.equal(
    index.entries.find((e) => e.path === 'index.json').sha256,
    undefined,
  );
  for (const name of [
    'intent.json',
    'child.json',
    'receipt.json',
    'contract.json',
    'phases.json',
    'qualification.json',
    'expected.json',
    'native.report.json',
    'setup-negative.report.json',
    'logs/setup.stdout.bin',
  ]) {
    assert.ok(
      index.entries.some((e) => e.path === name),
      name,
    );
  }
  assert.equal(existsSync(join(r.runRoot, '.status.pending')), false);
});

test('interrupted finalization preserves staged evidence without publishing status success', () => {
  const root = ownedScratch();
  writeFileSync(join(root, 'raw-evidence'), 'keep');
  assert.throws(
    () =>
      finalizeRun(
        root,
        { exitCode: 0 },
        {},
        {
          renameSync: () => {
            throw new Error('forced-publish-interruption');
          },
        },
      ),
    /forced-publish-interruption/,
  );
  assert.equal(existsSync(join(root, 'status.json')), false);
  assert.equal(readFileSync(join(root, 'raw-evidence'), 'utf8'), 'keep');
  assert.ok(existsSync(join(root, '.status.pending')));
  assert.ok(existsSync(join(root, 'index.json')));
  assert.throws(() => finalizeRun(root, { exitCode: 0 }), /EEXIST/);
  assert.equal(existsSync(join(root, 'status.json')), false);
});

test('preexisting completion object refuses finalization without overwriting it', () => {
  const root = ownedScratch();
  const foreign = join(ownedScratch(), 'foreign');
  writeFileSync(foreign, 'preserve');
  symlinkSync(foreign, join(root, 'index.json'));
  assert.throws(() => finalizeRun(root, { exitCode: 0 }), /EEXIST/);
  assert.equal(readFileSync(foreign, 'utf8'), 'preserve');
  assert.equal(existsSync(join(root, 'status.json')), false);
});

test('a deadline refusal at final publication leaves the finalized inventory incomplete', () => {
  const root = ownedScratch();
  writeFileSync(join(root, 'raw-evidence'), 'keep');
  assert.throws(
    () =>
      finalizeRun(
        root,
        { exitCode: 0 },
        {},
        {
          renameSync,
          beforePublish: () => {
            throw new Error('provider-clock-expired');
          },
        },
      ),
    /provider-clock-expired/,
  );
  assert.equal(existsSync(join(root, 'status.json')), false);
  assert.equal(readFileSync(join(root, 'raw-evidence'), 'utf8'), 'keep');
  assert.ok(existsSync(join(root, 'index.json')));
  assert.ok(existsSync(join(root, '.status.pending')));
});

for (const defect of ['unfinished', 'failed']) {
  test(`even a freshly inventoried ${defect} phase journal cannot become success`, async () => {
    const r = await completedRun();
    editJson(join(r.runRoot, 'phases.json'), (journal) => {
      if (defect === 'unfinished') journal.phases.pop();
      else journal.phases[0].exitCode = 1;
    });
    const status = JSON.parse(readFileSync(join(r.runRoot, 'status.json')));
    rmSync(join(r.runRoot, 'status.json'));
    rmSync(join(r.runRoot, 'index.json'));
    finalizeRun(r.runRoot, status);
    const before = snapshot(r.root);
    await assert.rejects(
      superviseInRunnerRun(r.args, r.deps),
      /existing-run-unverified/,
    );
    assert.equal(r.spawns.length, 1);
    assert.deepEqual(snapshot(r.root), before);
  });
}

test('a different currently admitted run cannot adopt a copied completed root', async () => {
  const r = await completedRun();
  const runId = canonicalRunId().replace('/r2', '/r3');
  assert.notEqual(runId, r.receipt.runId);
  editJson(r.args.receiptPath, (receipt) => {
    receipt.runId = runId;
  });
  const facts = r.deps.readRunFacts;
  r.deps.readRunFacts = () => ({ ...facts(), runId });
  const copied = join(r.args.outputPath, runRootBasename(runId));
  cpSync(r.runRoot, copied, { recursive: true });
  const before = snapshot(r.root);
  await assert.rejects(
    superviseInRunnerRun(r.args, r.deps),
    /existing-run-unverified/,
  );
  assert.equal(r.spawns.length, 1);
  assert.deepEqual(snapshot(r.root), before);
});
