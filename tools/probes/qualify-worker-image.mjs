#!/usr/bin/env node
// Isolated local candidate qualification. No build, publish, or rollout.
// --in-runner: one deterministic source-owned qualification inside the image.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  cpSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { driverEnvironment } from './in-runner-image.mjs';
import { runNativeProcess } from './native-process.mjs';
import {
  artifactHashes,
  evaluateImageEvidence,
} from './qualification-evidence.mjs';
import { imageScenario } from './qualification-scenario.mjs';
import { imageVersion } from './qualification-version.mjs';
import { KEEP_EVIDENCE_ENV } from './scratch.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const selfPath = fileURLToPath(import.meta.url);
const IMAGE_RE = /^sha256:[a-f0-9]{64}$/;

// --- host Docker route (interface preserved unchanged) ----------------------

export const HOST_ISOLATION = [
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
];

export function hostMountArgs(sourceDir) {
  return [
    'tools/probes',
    'packages/fleet-tools/bin',
    'apps/runner-autoscaler/runner-image/direct-runner.sh',
    ...[
      'worker-policy-bootstrap.sh',
      'worker-activation.sh',
      'verify-outcome.sh',
      'worker-completion.sh',
    ].map((name) => 'apps/runner-autoscaler/runner-image/runtime/' + name),
  ].flatMap((path) => [
    '--mount',
    'type=bind,src=' +
      join(sourceDir, path) +
      ',dst=/qualification/' +
      path +
      ',readonly',
  ]);
}

export function hostVersionArgs(imageId, provider) {
  return [
    ...HOST_ISOLATION,
    '--entrypoint',
    '/bin/bash',
    imageId,
    '-c',
    'command -v "$1"; "$1" --version',
    'qualification-version',
    provider,
  ];
}

export function hostScenarioArgs(
  sourceDir,
  imageId,
  provider,
  binary,
  providerVersion,
  scenario,
) {
  return [
    ...HOST_ISOLATION,
    ...hostMountArgs(sourceDir),
    '-e',
    'LCARS_PROBE_KEEP_EVIDENCE=1',
    '--entrypoint',
    'node',
    imageId,
    '/qualification/tools/probes/in-runner-image.mjs',
    provider,
    binary,
    providerVersion,
    imageId,
    ...(scenario === 'native' ? [] : [scenario]),
  ];
}

async function runHostQualification([provider, imageId, outputPath, ...extra]) {
  if (
    !['claude', 'codex', 'opencode'].includes(provider) ||
    !IMAGE_RE.test(imageId ?? '') ||
    !outputPath ||
    extra.length
  )
    throw new Error(
      'usage: qualify-worker-image.mjs <provider> <inspected-sha256-image-id> <new-output-directory>',
    );

  const output = resolve(outputPath);
  // Mount syntax cannot safely represent these path delimiters.
  if (source.includes(',') || source.includes(':'))
    throw new Error('Source path contains an unsupported mount delimiter');
  const command = (binary, args, timeout = 30000) => {
    const result = spawnSync(binary, args, {
      cwd: source,
      encoding: 'utf8',
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        binary + ' failed: ' + (result.error?.message ?? result.stderr),
      );
    return result.stdout.trim();
  };
  const sourceCommit = command('git', ['rev-parse', 'HEAD']);
  command('git', [
    'diff',
    '--exit-code',
    'HEAD',
    '--',
    'tools/probes',
    'packages/fleet-tools/bin',
    'apps/runner-autoscaler/runner-image',
  ]);
  if (
    command('git', [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      'tools/probes',
      'packages/fleet-tools/bin',
      'apps/runner-autoscaler/runner-image',
    ])
  )
    throw new Error('Qualification inputs must be committed');
  const startedAt = new Date().toISOString();
  const inspected = JSON.parse(
    command('docker', ['image', 'inspect', imageId]),
  );
  if (inspected.length !== 1 || inspected[0].Id !== imageId)
    throw new Error(
      'Candidate must resolve to the exact inspected local image ID',
    );
  mkdirSync(output); // Never overwrite another qualification run.

  const [binary, providerVersion, ...unexpected] = (
    await imageVersion(hostVersionArgs(imageId, provider), output)
  ).split('\n');
  if (!binary?.startsWith('/') || !providerVersion || unexpected.length)
    throw new Error('Cannot establish exact image-baked CLI identity');
  const expected = {
    provider,
    providerVersion,
    imageId,
    sourceCommit,
    ...artifactHashes(source),
  };
  writeFileSync(
    join(output, 'expected.json'),
    JSON.stringify(expected, null, 2),
  );

  const reports = [];
  for (const scenario of ['native', 'setup-negative']) {
    reports.push(
      await imageScenario(
        hostScenarioArgs(
          source,
          imageId,
          provider,
          binary,
          providerVersion,
          scenario,
        ),
        output,
        scenario,
      ),
    );
  }
  const result = evaluateImageEvidence(expected, ...reports);
  writeFileSync(
    join(output, 'qualification.json'),
    JSON.stringify(
      {
        ...expected,
        ...result,
        startedAt,
        completedAt: new Date().toISOString(),
        evidence: [
          'native/image-observations.json',
          'setup-negative/image-observations.json',
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.offlinePassed ? 0 : 1;
}

// --- in-runner allocation binding ---------------------------------------------

export const RUNNER_UID = 1001;
export const EXPECTED_CPU_CORES = 2;
export const EXPECTED_MEMORY_BYTES = 6442450944;
export const RUN_ID_RE = /^work:[0-9A-HJKMNP-TV-Z]{26}\/r[1-9][0-9]*$/;
export const BAKED_BIN = '/opt/agent-tools/bin';
export const BAKED_RUNTIME = '/usr/local/lib/agent-lcars/runtime';
export const BAKED_RUNNER = '/usr/local/lib/agent-lcars/direct-runner.sh';
export const CONSUMER_FILES = [
  'native-failure-qualification.ts',
  'failure-qualification.config.mts',
];
export const RUNTIME_HELPER_NAMES = [
  'worker-policy-bootstrap.sh',
  'worker-activation.sh',
  'verify-outcome.sh',
  'worker-completion.sh',
];

export const hashFile = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

export function bakedInputMap(sourceDir) {
  const map = {};
  for (const name of readdirSync(
    join(sourceDir, 'packages/fleet-tools/bin'),
  ).filter((candidate) =>
    /^(worker-|fleet-identity).*\.(cjs|mjs)$/.test(candidate),
  ))
    map[name] = [
      join(sourceDir, 'packages/fleet-tools/bin', name),
      join(BAKED_BIN, name),
    ];
  for (const name of RUNTIME_HELPER_NAMES)
    map[name] = [
      join(sourceDir, 'apps/runner-autoscaler/runner-image/runtime', name),
      join(BAKED_RUNTIME, name),
    ];
  map['direct-runner.sh'] = [
    join(sourceDir, 'apps/runner-autoscaler/runner-image/direct-runner.sh'),
    BAKED_RUNNER,
  ];
  return map;
}

export function consumerHashes(sourceDir) {
  return Object.fromEntries(
    CONSUMER_FILES.map((name) => [
      name,
      hashFile(join(sourceDir, 'tools/probes', name)),
    ]),
  );
}

export function readRunFacts(cgroupRoot = '/sys/fs/cgroup') {
  let cpuCores = null;
  let memoryBytes = null;
  try {
    const [quota, period] = readFileSync(join(cgroupRoot, 'cpu.max'), 'utf8')
      .trim()
      .split(/\s+/);
    cpuCores = quota === 'max' ? null : Number(quota) / Number(period);
  } catch {
    /* limits unavailable */
  }
  try {
    const memory = readFileSync(join(cgroupRoot, 'memory.max'), 'utf8').trim();
    memoryBytes = memory === 'max' ? null : Number(memory);
  } catch {
    /* limits unavailable */
  }
  return {
    uid: process.getuid(),
    hostname: hostname(),
    arch: process.arch,
    runId: process.env.LCARS_RUN_ID ?? null,
    cpuCores,
    memoryBytes,
    nowMs: Date.now(),
  };
}

const sorted = (value) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      item && !Array.isArray(item) && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    ),
  );

// Fail-closed binding of the Root-authenticated allocation receipt and the
// approved source contract to the actual run. No old-run inputs are consulted.
export function allocationFailures({
  provider,
  receipt,
  contract,
  actual,
  sourceHashes,
}) {
  const failures = [];
  if (!['claude', 'codex', 'opencode'].includes(provider))
    failures.push('provider-unknown');
  if (receipt?.provider !== provider)
    failures.push('receipt-provider-mismatch');
  if (contract?.provider !== provider)
    failures.push('contract-provider-mismatch');
  if (!IMAGE_RE.test(receipt?.imageId ?? '')) failures.push('receipt-image-id');
  if (contract?.imageId !== receipt?.imageId)
    failures.push('contract-image-mismatch');
  const runId = receipt?.runId ?? '';
  if (!RUN_ID_RE.test(runId)) failures.push('receipt-run-id-not-canonical');
  if (!RUN_ID_RE.test(actual?.runId ?? '') || actual.runId !== runId)
    failures.push('run-id-not-bound');
  if (receipt?.uid !== RUNNER_UID || actual.uid !== RUNNER_UID)
    failures.push('uid-not-runner');
  if (!receipt?.hostname || actual.hostname !== receipt.hostname)
    failures.push('hostname-mismatch');
  if (!receipt?.arch || actual.arch !== receipt.arch)
    failures.push('arch-mismatch');
  if (actual.cpuCores !== EXPECTED_CPU_CORES)
    failures.push('cgroup-cpu-actual');
  if (receipt?.cpuCores !== EXPECTED_CPU_CORES)
    failures.push('cgroup-cpu-receipt');
  if (actual.memoryBytes !== EXPECTED_MEMORY_BYTES)
    failures.push('cgroup-memory-actual');
  if (receipt?.memoryBytes !== EXPECTED_MEMORY_BYTES)
    failures.push('cgroup-memory-receipt');
  const startedAt = receipt?.startedAt;
  const expiresAt = receipt?.expiresAt;
  const started = Date.parse(startedAt ?? '');
  const expires = Date.parse(expiresAt ?? '');
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(expires) ||
    startedAt !== new Date(started).toISOString() ||
    expiresAt !== new Date(expires).toISOString() ||
    started >= expires
  )
    failures.push('receipt-clock-not-canonical');
  else if (actual.nowMs < started) failures.push('provider-clock-not-started');
  else if (actual.nowMs >= expires) failures.push('provider-clock-expired');
  if (!/^[a-f0-9]{40}$/.test(contract?.sourceCommit ?? ''))
    failures.push('contract-source-commit');
  if (
    typeof contract?.providerVersion !== 'string' ||
    !contract.providerVersion
  )
    failures.push('contract-provider-version');
  const baked = contract?.bakedHashes;
  const wanted = Object.keys(bakedInputMap(source));
  if (
    !baked ||
    JSON.stringify(Object.keys(baked).sort()) !==
      JSON.stringify([...wanted].sort()) ||
    wanted.some((name) => !/^[a-f0-9]{64}$/.test(baked[name] ?? ''))
  )
    failures.push('contract-baked-incomplete');
  if (
    JSON.stringify(sorted(contract?.probeHashes)) !==
    JSON.stringify(sorted(sourceHashes.probeHashes))
  )
    failures.push('contract-harness-mismatch');
  const consumers = consumerHashes(source);
  if (
    JSON.stringify(sorted(contract?.consumerHashes)) !==
    JSON.stringify(sorted(consumers))
  )
    failures.push('contract-consumer-mismatch');
  return failures;
}

// The canonical run id contains ':' and '/'; a directory basename must not
// smuggle a path separator, so the run root is a fixed safe encoding of it.
export const runRootBasename = (runId) =>
  'run-' +
  createHash('sha256')
    .update('lcars-run:v1:' + runId)
    .digest('hex')
    .slice(0, 32);

export function claimRunRoot(output, runId) {
  const runRoot = join(output, runRootBasename(runId));
  try {
    mkdirSync(runRoot);
    return { claimed: true, runRoot };
  } catch (error) {
    if (error.code === 'EEXIST') return { claimed: false, runRoot };
    throw error;
  }
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const containedPath = (root, path) => {
  const target = resolve(path);
  return target === root || target.startsWith(root + sep);
};

function procBirth(pid) {
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    return {
      procStarttime: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
    };
  } catch {
    return null;
  }
}

export const defaultSupervisorDeps = {
  readRunFacts,
  artifactHashes,
  hashFile,
  spawnChild(runRoot) {
    const outFd = openSync(
      join(runRoot, 'logs', 'entry.stdout.log'),
      'wx',
      0o600,
    );
    const errFd = openSync(
      join(runRoot, 'logs', 'entry.stderr.log'),
      'wx',
      0o600,
    );
    const child = spawn(
      process.execPath,
      [selfPath, '--in-runner-child', runRoot],
      {
        detached: true,
        cwd: source,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        stdio: ['ignore', outFd, errFd],
      },
    );
    closeSync(outFd);
    closeSync(errFd);
    return {
      pid: child.pid,
      birth: procBirth(child.pid),
      wait: () =>
        new Promise((done) => {
          child.on('error', (error) => done({ spawnError: error.message }));
          child.on('exit', (code, signal) => done({ code, signal }));
        }),
    };
  },
};

// One deterministic entry: the exclusive run-root claim happens before any
// phase, so a status re-read can never start a second child.
export async function superviseInRunnerRun(
  { provider, receiptPath, contractPath, outputPath },
  deps = defaultSupervisorDeps,
) {
  const receipt = readJson(resolve(receiptPath));
  if (!receipt) throw new Error('Allocation receipt is missing or malformed');
  const contract = readJson(resolve(contractPath));
  if (!contract) throw new Error('Source contract is missing or malformed');
  const failures = allocationFailures({
    provider,
    receipt,
    contract,
    actual: deps.readRunFacts(),
    sourceHashes: deps.artifactHashes(source),
  });
  if (failures.length)
    throw new Error('Qualification allocation refused: ' + failures.join(', '));
  const output = resolve(outputPath);
  // A status re-read targets the same output; single-entry is enforced by
  // the exclusive run-root claim below.
  mkdirSync(output, { recursive: true });
  const { claimed, runRoot } = claimRunRoot(output, receipt.runId);
  const status = readJson(join(runRoot, 'status.json'));
  if (!claimed)
    return {
      claimed: false,
      runRoot,
      exitCode: status?.exitCode ?? 1,
      child: readJson(join(runRoot, 'child.json')),
      status,
    };
  const intent = {
    schema: 'lcars-in-runner-qualification-v1',
    provider,
    runId: receipt.runId,
    imageId: receipt.imageId,
    claimedAt: new Date().toISOString(),
    providerClock: {
      startedAt: receipt.startedAt,
      expiresAt: receipt.expiresAt,
    },
    receiptSha: deps.hashFile(resolve(receiptPath)),
    contractSha: deps.hashFile(resolve(contractPath)),
    artifactHashes: deps.artifactHashes(source),
  };
  writeFileSync(join(runRoot, 'intent.json'), JSON.stringify(intent, null, 2));
  cpSync(resolve(receiptPath), join(runRoot, 'receipt.json'));
  cpSync(resolve(contractPath), join(runRoot, 'contract.json'));
  mkdirSync(join(runRoot, 'logs'));
  mkdirSync(join(runRoot, 'fixtures'));
  mkdirSync(join(runRoot, 'retained'));
  const entry = deps.spawnChild(runRoot);
  if (!entry?.pid) throw new Error('Qualification entry child did not start');
  writeFileSync(
    join(runRoot, 'child.json'),
    JSON.stringify(
      {
        pid: entry.pid,
        birth: entry.birth,
        entryScript: selfPath,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  const outcome = await entry.wait();
  const final = readJson(join(runRoot, 'status.json'));
  return {
    claimed: true,
    runRoot,
    exitCode: final?.exitCode ?? 1,
    status: final,
    outcome,
    ...(final ? {} : { unknown: 'entry child ended without writing status' }),
  };
}

// --- in-runner child phases --------------------------------------------------

export const VERSION_TIMEOUT_MS = 30000;
export const SETUP_TIMEOUT_MS = 10 * 60000;
export const SCENARIO_TIMEOUT_MS = 50 * 60000;
export const CONSUMER_TIMEOUT_MS = 30 * 60000;

class PhaseFailure extends Error {}

export function defaultCollectBakedInputs(contract, runRoot) {
  const captured = [];
  for (const [name, [, bakedPath]] of Object.entries(bakedInputMap(source))) {
    const actual = hashFile(bakedPath);
    if (actual !== contract.bakedHashes[name])
      throw new PhaseFailure('baked-input-mismatch: ' + name);
    const dest = join(runRoot, 'retained', 'baked', name);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(bakedPath, dest);
    captured.push({ name, hash: actual, retained: relative(runRoot, dest) });
  }
  return { roots: [BAKED_BIN, BAKED_RUNTIME, BAKED_RUNNER], captured };
}

// Approved source identity is confirmed against the actual checkout before
// any probe runs: real Git HEAD plus every source-side baked input must match
// the contract. Baked-only hashes alone do not cover source drift.
export function readGitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: source,
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGKILL',
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

// The lifecycle executes these files, so a dirty copy is a different run even
// when HEAD and the baked hashes still match. The list is the exact set of
// paths the command itself runs or hashes — never a broad tree scan.
export const SETUP_INPUT_FILES = [
  'tools/setup-worktree.sh',
  'tools/setup-nx-native-file-cache.sh',
  'tools/setup-git-hooks.sh',
  'package.json',
  'pnpm-lock.yaml',
];
export const HARNESS_INPUT_FILES = [
  'tools/probes/qualify-worker-image.mjs',
  'tools/probes/in-runner-image.mjs',
  'tools/probes/native-process.mjs',
  'tools/probes/qualification-evidence.mjs',
  'tools/probes/qualification-scenario.mjs',
  'tools/probes/qualification-version.mjs',
  'tools/probes/scratch.mjs',
  ...CONSUMER_FILES.map((name) => 'tools/probes/' + name),
];

export function owningInputPaths(sourceDir = source) {
  const baked = Object.values(bakedInputMap(sourceDir)).map(([path]) =>
    relative(sourceDir, path).split(sep).join('/'),
  );
  return [...new Set([...baked, ...SETUP_INPUT_FILES, ...HARNESS_INPUT_FILES])];
}

function gitStatus(paths, cwd) {
  const result = spawnSync('git', ['status', '--porcelain=1', '--', ...paths], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGKILL',
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

// Fail closed: no status, no path list, or any dirty/untracked owning input
// all refuse the run before the setup phase can execute a modified script.
export function dirtyOwningInputFailures(
  paths,
  { cwd = source, status = gitStatus } = {},
) {
  if (!paths.length) return ['owning-inputs-unavailable'];
  const output = status(paths, cwd);
  if (output === null) return ['owning-inputs-status-unavailable'];
  return output
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => 'owning-input-dirty: ' + line.slice(3).trim());
}

export function sourceDriftFailures(
  contract,
  {
    readHead = readGitHead,
    hash = hashFile,
    dirty = (paths) => dirtyOwningInputFailures(paths),
    paths = owningInputPaths(),
  } = {},
) {
  const failures = [];
  const head = readHead();
  if (!/^[a-f0-9]{40}$/.test(head ?? ''))
    failures.push('source-head-unavailable');
  else if (head !== contract?.sourceCommit) failures.push('source-head-drift');
  for (const [name, [sourcePath]] of Object.entries(bakedInputMap(source))) {
    let actual = null;
    try {
      actual = hash(sourcePath);
    } catch {
      /* source input missing */
    }
    if (actual !== contract?.bakedHashes?.[name])
      failures.push('source-input-drift: ' + name);
  }
  failures.push(...dirty(paths));
  return failures;
}

export const defaultChildDeps = {
  runProcess: runNativeProcess,
  evaluate: evaluateImageEvidence,
  collectBakedInputs: defaultCollectBakedInputs,
  verifySourceContract: (contract) => sourceDriftFailures(contract),
};

export async function executeInRunnerPhases(runRoot, deps = defaultChildDeps) {
  const intent = readJson(join(runRoot, 'intent.json'));
  if (!intent) throw new PhaseFailure('missing intent');
  const contract = readJson(join(runRoot, 'contract.json'));
  const phases = [];
  const unknowns = [];
  const externalChecks = [];
  const reports = {};
  let expected = null;
  let evaluated = null;
  let stopped = null;
  let localProbePassed = false;
  // A phase killed from outside never reports its own exit, and killing this
  // wrapper's process group cannot certify the driver's nested provider group.
  let nestedRetirement = 'confirmed';
  const remainingMs = () =>
    Date.parse(intent.providerClock.expiresAt) - Date.now();
  const succeeded = (result) =>
    result.code === 0 &&
    !result.timedOut &&
    (result.recording?.error ?? null) === null;
  async function runPhase(name, { binary, args, cwd, env, timeout }) {
    // Deadlines bind to the original provider clock; no late-phase reset.
    const bounded = Math.min(timeout, remainingMs());
    if (bounded <= 0) throw new PhaseFailure('provider-clock-expired');
    const result = await deps.runProcess(binary, args, cwd, env, bounded, {
      stdoutPath: join(runRoot, 'logs', name + '.stdout.bin'),
      stderrPath: join(runRoot, 'logs', name + '.stderr.bin'),
    });
    phases.push({
      phase: name,
      binary,
      args,
      cwd,
      envKeys: Object.keys(env).sort(),
      deadlineMs: bounded,
      exitCode: result.code,
      timedOut: result.timedOut,
      spawnError: result.diagnostics?.spawnError ?? null,
      durationMs: result.diagnostics?.durationMs ?? null,
      recording: result.recording ?? null,
    });
    if (result.code === null || result.timedOut) {
      nestedRetirement = 'unknown';
      unknowns.push('nested-retirement-unknown: ' + name);
    }
    return result;
  }
  try {
    const drift = deps.verifySourceContract(contract);
    if (drift.length)
      throw new PhaseFailure('source-drift: ' + drift.join(', '));
    deps.collectBakedInputs(contract, runRoot);
    const setup = await runPhase('setup', {
      binary: '/bin/bash',
      args: [join(source, 'tools/setup-worktree.sh')],
      cwd: source,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      timeout: SETUP_TIMEOUT_MS,
    });
    if (!succeeded(setup)) throw new PhaseFailure('setup-phase-failed');
    const version = await runPhase('version', {
      binary: '/bin/bash',
      args: [
        '-c',
        'command -v "$1"; "$1" --version',
        'qualification-version',
        intent.provider,
      ],
      cwd: source,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      timeout: VERSION_TIMEOUT_MS,
    });
    if (!succeeded(version)) throw new PhaseFailure('version-phase-failed');
    const [binary, providerVersion, ...extra] = version.stdout
      .trim()
      .split('\n');
    if (!binary?.startsWith('/') || !providerVersion || extra.length)
      throw new PhaseFailure('cannot establish image-baked CLI identity');
    if (providerVersion !== contract.providerVersion)
      throw new PhaseFailure('provider-version-mismatch');
    expected = {
      provider: intent.provider,
      providerVersion,
      imageId: intent.imageId,
      sourceCommit: contract.sourceCommit,
      ...intent.artifactHashes,
    };
    writeFileSync(
      join(runRoot, 'expected.json'),
      JSON.stringify(expected, null, 2),
    );
    for (const scenario of ['native', 'setup-negative']) {
      const result = await runPhase(scenario, {
        binary: process.execPath,
        args: [
          join(source, 'tools/probes', 'in-runner-image.mjs'),
          intent.provider,
          binary,
          providerVersion,
          intent.imageId,
          ...(scenario === 'native' ? [] : [scenario]),
        ],
        cwd: source,
        env: driverEnvironment(
          {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: join(runRoot, 'fixtures'),
            [KEEP_EVIDENCE_ENV]: '1',
          },
          intent.provider,
        ),
        timeout: SCENARIO_TIMEOUT_MS,
      });
      if (!succeeded(result))
        throw new PhaseFailure('scenario-failed: ' + scenario);
      // The in-memory result.stdout tail is a diagnostic bound, not the
      // answer: a valid report larger than the tail would be rejected there.
      // Evaluate the complete owned recorded stdout the process actually wrote.
      const recorded = result.recording?.stdoutPath;
      if (typeof recorded !== 'string' || !containedPath(runRoot, recorded))
        throw new PhaseFailure('scenario-record-missing: ' + scenario);
      let report;
      try {
        report = JSON.parse(readFileSync(recorded, 'utf8'));
      } catch {
        throw new PhaseFailure('malformed-report: ' + scenario);
      }
      reports[scenario] = report;
      writeFileSync(
        join(runRoot, scenario + '.report.json'),
        JSON.stringify(report, null, 2),
      );
      for (const pointer of [
        report.diagnosticsDirectory,
        report.nativeReport?.evidenceDirectory,
      ])
        externalChecks.push({
          phase: scenario,
          pointer,
          owned: typeof pointer === 'string' && containedPath(runRoot, pointer),
        });
    }
    evaluated = deps.evaluate(
      expected,
      reports.native,
      reports['setup-negative'],
    );
    const consumer = await runPhase('failure-consumer', {
      binary: 'pnpm',
      args: [
        'exec',
        'vitest',
        'run',
        '--config',
        'tools/probes/failure-qualification.config.mts',
      ],
      cwd: source,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LCARS_NATIVE_FAILURE_REPORTS: JSON.stringify([
          join(runRoot, 'native.report.json'),
        ]),
      },
      timeout: CONSUMER_TIMEOUT_MS,
    });
    localProbePassed = evaluated.offlinePassed && succeeded(consumer);
    if (!localProbePassed) throw new PhaseFailure('local-probe-did-not-pass');
  } catch (error) {
    stopped = error?.message ?? String(error);
    unknowns.push('partial-run: phases after the stop were never attempted');
  } finally {
    writeFileSync(
      join(runRoot, 'phases.json'),
      JSON.stringify({ intent, phases, externalChecks, stopped }, null, 2),
    );
    writeFileSync(
      join(runRoot, 'qualification.json'),
      JSON.stringify(
        {
          schema: 'lcars-in-runner-qualification-v1',
          localProbePassed,
          durableCollectionComplete: false,
          qualificationAccepted: false,
          cleanupAuthorized: false,
          graduated: false,
          activationAuthorized: false,
          offlineEvaluation: evaluated,
          stopped,
          nestedRetirement,
          unknowns,
          provenance: {
            provider: intent.provider,
            imageId: intent.imageId,
            receiptSha: intent.receiptSha,
            contractSha: intent.contractSha,
            providerClock: intent.providerClock,
            expected:
              expected ?? readJson(join(runRoot, 'expected.json')) ?? null,
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(runRoot, 'index.json'),
      JSON.stringify(
        indexRoot(runRoot, {
          ...(defaultCollectBakedInputs === deps.collectBakedInputs
            ? { retainedRoots: [BAKED_BIN, BAKED_RUNTIME, BAKED_RUNNER] }
            : {}),
          nestedRetirement,
        }),
      ),
    );
    const exitCode = localProbePassed ? 0 : 1;
    writeFileSync(
      join(runRoot, 'status.json'),
      JSON.stringify({
        exitCode,
        stopped,
        finishedAt: new Date().toISOString(),
      }),
    );
  }
  return localProbePassed ? 0 : 1;
}

// Every run-root entry by role with dev/ino/UID; external symlink targets are
// explicit pointers, never silently followed or ignored.
export function indexRoot(
  runRoot,
  { retainedRoots = [], nestedRetirement = 'confirmed' } = {},
) {
  const entries = [];
  const externalPointers = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = relative(runRoot, path).split(sep).join('/');
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        const resolved = resolve(dirname(path), target);
        const owned = containedPath(runRoot, resolved);
        const retained =
          !owned && retainedRoots.some((root) => containedPath(root, resolved));
        entries.push({ path: rel, type: 'link', target, owned, retained });
        if (!owned)
          externalPointers.push({ path: rel, target, retained: retained });
        continue;
      }
      entries.push({
        path: rel,
        type: stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other',
        role: rel.startsWith('logs/')
          ? 'log'
          : rel.startsWith('fixtures/')
            ? 'fixture'
            : rel.startsWith('retained/')
              ? 'retained'
              : /^(index|status)\.json$/.test(rel)
                ? 'index'
                : [
                      'intent.json',
                      'child.json',
                      'receipt.json',
                      'contract.json',
                    ].includes(rel)
                  ? 'journal'
                  : rel.endsWith('.json')
                    ? 'report'
                    : 'entry',
        dev: stat.dev,
        ino: stat.ino,
        uid: stat.uid,
        mode: stat.mode & 0o777,
        size: stat.size,
      });
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(runRoot);
  return {
    root: runRoot,
    nestedRetirement,
    // Unknown nested termination means fixture writers may still be live: the
    // data stays preserved but retention cannot be certified.
    retention:
      nestedRetirement === 'confirmed' &&
      externalPointers.every((pointer) => pointer.retained)
        ? 'complete'
        : 'incomplete',
    externalPointers,
    entries,
  };
}

// --- entry point --------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === selfPath) {
  const [first, ...rest] = process.argv.slice(2);
  const main = async () => {
    if (first === '--in-runner-child')
      process.exitCode = await executeInRunnerPhases(resolve(rest[0] ?? ''));
    else if (first === '--in-runner') {
      const [provider, receiptPath, contractPath, outputPath, ...extra] = rest;
      if (
        !provider ||
        !receiptPath ||
        !contractPath ||
        !outputPath ||
        extra.length
      )
        throw new Error(
          'usage: qualify-worker-image.mjs --in-runner <provider> <allocation-receipt.json> <approved-source-contract.json> <new-output-directory>',
        );
      const result = await superviseInRunnerRun({
        provider,
        receiptPath,
        contractPath,
        outputPath,
      });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.exitCode;
    } else await runHostQualification(process.argv.slice(2));
  };
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
