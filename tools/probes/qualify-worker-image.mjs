#!/usr/bin/env node
// Isolated local candidate qualification. No build, publish, or rollout.
// --in-runner: one deterministic source-owned qualification inside the image.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  cpSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
  writeSync,
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

// hrtime is system-monotonic on Linux, shared across processes on one boot.
// Bind the serialized deadline to that boot; process-relative clocks cannot
// safely transfer a deadline from the supervisor to its child.
export function readMonotonicClock() {
  return {
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    nowMs: Number(process.hrtime.bigint()) / 1e6,
  };
}

function validClock(clock) {
  return (
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(clock?.bootId ?? '') &&
    Number.isFinite(clock?.nowMs) &&
    clock.nowMs >= 0
  );
}

export function admitProviderDeadline(receipt, wallNowMs, clock) {
  const remaining = Date.parse(receipt?.expiresAt) - wallNowMs;
  if (
    !validClock(clock) ||
    !Number.isFinite(wallNowMs) ||
    !Number.isFinite(remaining) ||
    remaining <= 0
  )
    throw new Error('provider-clock-expired-or-invalid');
  const deadlineMs = clock.nowMs + remaining;
  if (!Number.isFinite(deadlineMs)) throw new Error('provider-clock-invalid');
  return { bootId: clock.bootId, admittedAtMs: clock.nowMs, deadlineMs };
}

function remainingProviderMs(deadline, clock) {
  if (
    !validClock(clock) ||
    deadline?.bootId !== clock.bootId ||
    !Number.isFinite(deadline?.admittedAtMs) ||
    deadline.admittedAtMs < 0 ||
    !Number.isFinite(deadline?.deadlineMs) ||
    deadline.deadlineMs <= deadline.admittedAtMs ||
    clock.nowMs < deadline.admittedAtMs
  )
    throw new PhaseFailure('provider-clock-invalid');
  const remaining = deadline.deadlineMs - clock.nowMs;
  if (remaining <= 0) throw new PhaseFailure('provider-clock-expired');
  return remaining;
}

// Root provisions these approvals outside the runner's writable namespace.
// Traverse pinned directory descriptors: neither symlinks nor replacement of a
// runner-writable parent may turn an arbitrary CLI path into an approval.
export function readApprovedInput(
  inputPath,
  io = {
    openSync,
    fstatSync,
    readFileSync,
    closeSync,
  },
) {
  const parts = resolve(inputPath).split(sep).filter(Boolean);
  let parent = io.openSync('/', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const [index, part] of parts.entries()) {
      const directory = index < parts.length - 1;
      const fd = io.openSync(
        '/proc/self/fd/' + parent + '/' + part,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (directory ? constants.O_DIRECTORY : 0),
      );
      let accepted = false;
      try {
        const stat = io.fstatSync(fd);
        if (
          stat.uid !== 0 ||
          (stat.mode & 0o022) !== 0 ||
          (directory ? !stat.isDirectory() : !stat.isFile())
        )
          throw new Error('qualification-approval-untrusted: ' + inputPath);
        accepted = true;
        if (!directory) {
          const bytes = io.readFileSync(fd);
          const after = io.fstatSync(fd);
          if (
            stat.size !== bytes.length ||
            stat.size !== after.size ||
            stat.mtimeMs !== after.mtimeMs ||
            stat.ctimeMs !== after.ctimeMs
          )
            throw new Error('qualification-approval-changed: ' + inputPath);
          return bytes;
        }
      } finally {
        if (!directory || !accepted) io.closeSync(fd);
      }
      io.closeSync(parent);
      parent = fd;
    }
    throw new Error('qualification-approval-not-file: ' + inputPath);
  } finally {
    io.closeSync(parent);
  }
}

export const defaultSupervisorDeps = {
  readApprovedInput,
  readRunFacts,
  readMonotonicClock,
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
  // Capture once: validation, identity and child copies share these exact bytes.
  const readApproval = deps.readApprovedInput ?? readApprovedInput;
  const receiptBytes = readApproval(receiptPath);
  const contractBytes = readApproval(contractPath);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  if (!receipt) throw new Error('Allocation receipt is missing or malformed');
  const contract = JSON.parse(contractBytes.toString('utf8'));
  const receiptSha = createHash('sha256').update(receiptBytes).digest('hex');
  const contractSha = createHash('sha256').update(contractBytes).digest('hex');
  if (!contract) throw new Error('Source contract is missing or malformed');
  const clock = (deps.readMonotonicClock ?? readMonotonicClock)();
  const actual = deps.readRunFacts();
  const failures = allocationFailures({
    provider,
    receipt,
    contract,
    actual,
    sourceHashes: deps.artifactHashes(source),
  });
  if (failures.length)
    throw new Error('Qualification allocation refused: ' + failures.join(', '));
  const output = resolve(outputPath);
  // Validate new admission before claiming anything; a reread below uses only
  // the stored deadline and never writes or transfers this fresh candidate.
  const monotonicDeadline = admitProviderDeadline(receipt, actual.nowMs, clock);
  // A status re-read targets the same output; single-entry is enforced by
  // the exclusive run-root claim below.
  mkdirSync(output, { recursive: true });
  const { claimed, runRoot } = claimRunRoot(output, receipt.runId);
  if (!claimed) {
    const status = rereadCompletedRun(runRoot, {
      provider,
      receipt,
      receiptSha,
      contractSha,
      artifactHashes: deps.artifactHashes(source),
      clock,
    });
    return {
      claimed: false,
      runRoot,
      exitCode: status.exitCode,
      child: readJson(join(runRoot, 'child.json')),
      status,
    };
  }
  const intent = {
    schema: 'lcars-in-runner-qualification-v1',
    provider,
    runId: receipt.runId,
    imageId: receipt.imageId,
    claimedAt: new Date().toISOString(),
    admittedWallMs: actual.nowMs,
    monotonicDeadline,
    providerClock: {
      startedAt: receipt.startedAt,
      expiresAt: receipt.expiresAt,
    },
    receiptSha,
    contractSha,
    artifactHashes: deps.artifactHashes(source),
  };
  writeFileSync(join(runRoot, 'intent.json'), JSON.stringify(intent, null, 2));
  writeFileSync(join(runRoot, 'receipt.json'), receiptBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(join(runRoot, 'contract.json'), contractBytes, {
    flag: 'wx',
    mode: 0o600,
  });
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

// Five production phases, two streams each: at most 640 MiB of raw phase
// streams. This does not cap fixture bytes, copied inputs or derived reports.
export const PHASE_STREAM_MAX_BYTES = 64 * 1024 * 1024;
export const VERSION_TIMEOUT_MS = 30000;
export const SETUP_TIMEOUT_MS = 10 * 60000;
export const SCENARIO_TIMEOUT_MS = 50 * 60000;
export const CONSUMER_TIMEOUT_MS = 30 * 60000;

class PhaseFailure extends Error {}

export function defaultCollectBakedInputs(
  contract,
  runRoot,
  {
    inputs = bakedInputMap(source),
    toolsRoot = dirname(BAKED_BIN),
    runtimeRoot = '/usr/local/lib/agent-lcars/runtime',
  } = {},
) {
  const captured = [];
  for (const [name, [, bakedPath]] of Object.entries(inputs)) {
    const actual = hashFile(bakedPath);
    if (actual !== contract.bakedHashes[name])
      throw new PhaseFailure('baked-input-mismatch: ' + name);
    const dest = join(runRoot, 'retained', 'baked', name);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(bakedPath, dest);
    captured.push({ name, hash: actual, retained: relative(runRoot, dest) });
  }
  // Scenarios link the entire fleet-tools package, not just its bin directory.
  // Preserve the actual target before certifying that external pointer. Links
  // within the copy remain links, resolved to their original absolute targets,
  // so relocation cannot turn an escaping relative link into an owned pointer.
  cpSync(toolsRoot, join(runRoot, 'retained', 'fleet-tools'), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: false,
  });
  cpSync(runtimeRoot, join(runRoot, 'retained', 'runtime'), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: false,
  });
  return {
    roots: [
      toolsRoot,
      runtimeRoot,
      ...Object.values(inputs).map(([, path]) => path),
    ],
    captured,
  };
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

// Git owns the committed-checkout boundary, including transitive setup/install
// inputs. Do not duplicate that dependency graph in a hand-maintained path list.
function gitStatus(cwd) {
  const result = spawnSync(
    'git',
    ['status', '--porcelain=1', '-z', '--untracked-files=all'],
    {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      encoding: 'utf8',
      timeout: 30000,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

// The child checks after the exclusive claim, so its own untracked evidence
// may already exist inside the checkout. Only those untracked descendants are
// exempt; staged/modified/deleted tracked files are never exempted.
export function dirtyOwningInputFailures({
  cwd = source,
  runRoot = null,
  status = gitStatus,
} = {}) {
  const output = status(cwd);
  if (typeof output !== 'string' || (output && !output.endsWith('\0')))
    return ['owning-inputs-status-unavailable'];
  for (const entry of output.split('\0').filter(Boolean)) {
    if (entry.startsWith('?? ') && runRoot) {
      const path = resolve(cwd, entry.slice(3));
      if (containedPath(resolve(runRoot), path)) continue;
    }
    return ['owning-input-dirty: ' + entry.slice(3)];
  }
  return [];
}

export function sourceDriftFailures(
  contract,
  {
    readHead = readGitHead,
    hash = hashFile,
    runRoot = null,
    dirty = () => dirtyOwningInputFailures({ runRoot }),
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
  failures.push(...dirty());
  return failures;
}

export const defaultChildDeps = {
  readMonotonicClock,
  runProcess: runNativeProcess,
  evaluate: evaluateImageEvidence,
  collectBakedInputs: defaultCollectBakedInputs,
  verifySourceContract: (contract, runRoot) =>
    sourceDriftFailures(contract, { runRoot }),
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
  let retainedRoots = [];
  const remainingMs = () =>
    remainingProviderMs(
      intent.monotonicDeadline,
      (deps.readMonotonicClock ?? readMonotonicClock)(),
    );
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
      maxBytes: PHASE_STREAM_MAX_BYTES,
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
    const drift = deps.verifySourceContract(contract, runRoot);
    if (drift.length)
      throw new PhaseFailure('source-drift: ' + drift.join(', '));
    retainedRoots = deps.collectBakedInputs(contract, runRoot).roots;
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
      ]) {
        // Optional fields may be absent; any advertised diagnostic location
        // must belong to this run so the final inventory can retain it.
        if (pointer === undefined) continue;
        const owned =
          typeof pointer === 'string' &&
          pointer.length > 0 &&
          containedPath(runRoot, pointer);
        externalChecks.push({ phase: scenario, pointer, owned });
        if (!owned)
          throw new PhaseFailure('diagnostic-pointer-outside-run: ' + scenario);
      }
    }
    remainingMs();
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
    remainingMs();
    localProbePassed = evaluated.offlinePassed && succeeded(consumer);
    if (!localProbePassed) throw new PhaseFailure('local-probe-did-not-pass');
  } catch (error) {
    stopped = error?.message ?? String(error);
    unknowns.push('partial-run: phases after the stop were never attempted');
  } finally {
    if (localProbePassed) {
      try {
        remainingMs();
      } catch (error) {
        localProbePassed = false;
        stopped = error.message;
      }
    }
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
    finalizeRun(
      runRoot,
      {
        exitCode: localProbePassed ? 0 : 1,
        stopped,
        finishedAt: new Date().toISOString(),
        finishedClock: (deps.readMonotonicClock ?? readMonotonicClock)(),
      },
      { retainedRoots, nestedRetirement },
      {
        renameSync,
        beforePublish: () => {
          if (localProbePassed) remainingMs();
        },
        checkDeadline: () => {
          if (localProbePassed) remainingMs();
        },
      },
    );
  }
  return localProbePassed ? 0 : 1;
}

// index.json cannot hash itself. Its final metadata is nevertheless exact;
// status and the identity/completion journals are content-bound by the index.
const COMPLETION_HASH_PATHS = new Set([
  'status.json',
  'intent.json',
  'receipt.json',
  'contract.json',
  'child.json',
  'phases.json',
  'qualification.json',
  'expected.json',
  'native.report.json',
  'setup-negative.report.json',
]);

function ownedStat(path, directory = false) {
  const stat = lstatSync(path);
  if (
    stat.uid !== process.getuid() ||
    !(directory ? stat.isDirectory() : stat.isFile())
  )
    throw new Error('run-artifact-not-owned-regular: ' + path);
  return stat;
}

// Bind the verdict produced with the collector's actual roots, without trusting
// retained labels to reconstruct those roots during a completed reread.
function indexSemanticsSHA256(index) {
  const byPath = (entries) =>
    [...entries].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const semantics = {
    retention: index.retention,
    externalPointers: byPath(index.externalPointers),
    nestedRetirement: index.nestedRetirement,
    links: byPath(index.entries.filter((entry) => entry.type === 'link')).map(
      ({ path, retained }) => ({ path, retained }),
    ),
  };
  return createHash('sha256')
    .update(JSON.stringify(sorted(semantics)))
    .digest('hex');
}

// Status becomes visible only after the index has its final bytes and inode.
// Rename preserves the staged status inode. Fixed-point sizing is bounded by
// four passes (only the decimal digit count of the index size can change).
export function finalizeRun(
  runRoot,
  status,
  options = {},
  io = { renameSync },
) {
  ownedStat(runRoot, true);
  const pending = join(runRoot, '.status.pending');
  const statusPath = join(runRoot, 'status.json');
  try {
    lstatSync(statusPath);
    throw new Error('completion-already-exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const semanticsSHA = indexSemanticsSHA256(indexRoot(runRoot, options));
  const statusFd = openSync(pending, 'wx', 0o600);
  try {
    writeFileSync(
      statusFd,
      JSON.stringify({ ...status, indexSemanticsSHA256: semanticsSHA }),
    );
    fsyncSync(statusFd);
  } finally {
    closeSync(statusFd);
  }
  const indexPath = join(runRoot, 'index.json');
  const fd = openSync(indexPath, 'wx', 0o600);
  try {
    const index = indexRoot(runRoot, options);
    if (indexSemanticsSHA256(index) !== semanticsSHA)
      throw new Error('completion-index-semantics-changed');
    const pendingEntry = index.entries.find(
      (e) => e.path === '.status.pending',
    );
    Object.assign(pendingEntry, {
      path: 'status.json',
      role: 'index',
      sha256: hashFile(pending),
    });
    index.entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    index.selfContentHash = 'excluded:index.json';
    const self = index.entries.find((e) => e.path === 'index.json');
    let bytes;
    let stable = false;
    for (let pass = 0; pass < 4; pass++) {
      bytes = Buffer.from(JSON.stringify(index));
      if (self.size === bytes.length) {
        stable = true;
        break;
      }
      self.size = bytes.length;
    }
    if (!stable) throw new Error('completion-index-size-unstable');
    // Do not replace index.json: its recorded inode must remain the final one.
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (written <= 0) throw new Error('completion-index-write-stalled');
      offset += written;
    }
    ftruncateSync(fd, bytes.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Any failure before this point retains an incomplete root with no status.
  io.beforePublish?.();
  if (indexSemanticsSHA256(indexRoot(runRoot, options)) !== semanticsSHA)
    throw new Error('completion-index-semantics-changed');
  // The inventory walk consumes provider time too. Check after it, with no
  // further traversal between this admission fence and atomic publication.
  io.checkDeadline?.();
  io.renameSync(pending, statusPath);
}

function rereadCompletedRun(runRoot, expected) {
  const refuse = () => {
    throw new Error('existing-run-unverified-or-incomplete');
  };
  try {
    ownedStat(runRoot, true);
    const names = [
      'intent.json',
      'receipt.json',
      'contract.json',
      'child.json',
      'phases.json',
      'qualification.json',
      'index.json',
      'status.json',
    ];
    for (const name of names) ownedStat(join(runRoot, name));
    const read = (name) => readJson(join(runRoot, name + '.json'));
    const intent = read('intent');
    const journal = read('phases');
    const qualification = read('qualification');
    const index = read('index');
    const status = read('status');
    const child = read('child');
    const same = (a, b) =>
      JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
    if (
      !intent ||
      !journal ||
      !qualification ||
      !index ||
      !status ||
      !Number.isSafeInteger(child?.pid) ||
      child.pid <= 0 ||
      !/^[0-9]+$/.test(child.birth?.procStarttime ?? '') ||
      typeof child.entryScript !== 'string' ||
      !child.entryScript.startsWith('/') ||
      !Number.isFinite(Date.parse(child.startedAt)) ||
      intent.schema !== 'lcars-in-runner-qualification-v1' ||
      intent.provider !== expected.provider ||
      intent.runId !== expected.receipt.runId ||
      intent.imageId !== expected.receipt.imageId ||
      intent.receiptSha !== expected.receiptSha ||
      intent.contractSha !== expected.contractSha ||
      hashFile(join(runRoot, 'receipt.json')) !== intent.receiptSha ||
      hashFile(join(runRoot, 'contract.json')) !== intent.contractSha ||
      !same(intent.artifactHashes, expected.artifactHashes) ||
      !same(intent.providerClock, {
        startedAt: expected.receipt.startedAt,
        expiresAt: expected.receipt.expiresAt,
      }) ||
      !same(journal.intent, intent)
    )
      refuse();
    // Admission above still requires a live receipt. Verify the original stored
    // deadline here without renewing or transferring a replacement clock.
    const deadline = intent.monotonicDeadline;
    if (
      !validClock(expected.clock) ||
      deadline?.bootId !== expected.clock.bootId ||
      !Number.isFinite(deadline?.admittedAtMs) ||
      deadline.admittedAtMs < 0 ||
      deadline.admittedAtMs > expected.clock.nowMs ||
      !Number.isFinite(deadline?.deadlineMs) ||
      deadline.deadlineMs <= deadline.admittedAtMs ||
      !Number.isFinite(intent.admittedWallMs) ||
      intent.admittedWallMs < Date.parse(expected.receipt.startedAt) ||
      intent.admittedWallMs >= Date.parse(expected.receipt.expiresAt) ||
      deadline.deadlineMs !==
        deadline.admittedAtMs +
          (Date.parse(expected.receipt.expiresAt) - intent.admittedWallMs)
    )
      refuse();
    if (
      ![0, 1].includes(status.exitCode) ||
      !Number.isFinite(Date.parse(status.finishedAt)) ||
      qualification.schema !== intent.schema ||
      qualification.localProbePassed !== (status.exitCode === 0) ||
      status.stopped !== qualification.stopped ||
      status.stopped !== journal.stopped ||
      !same(qualification.provenance, {
        provider: intent.provider,
        imageId: intent.imageId,
        receiptSha: intent.receiptSha,
        contractSha: intent.contractSha,
        providerClock: intent.providerClock,
        expected: read('expected'),
      }) ||
      [
        'durableCollectionComplete',
        'qualificationAccepted',
        'cleanupAuthorized',
        'graduated',
        'activationAuthorized',
      ].some((key) => qualification[key] !== false) ||
      !Array.isArray(journal.phases) ||
      !Array.isArray(journal.externalChecks) ||
      !Array.isArray(qualification.unknowns) ||
      !Array.isArray(index.entries) ||
      index.root !== runRoot ||
      index.selfContentHash !== 'excluded:index.json'
    )
      refuse();
    if (status.exitCode === 0) {
      remainingProviderMs(deadline, status.finishedClock);
      for (const name of [
        'expected.json',
        'native.report.json',
        'setup-negative.report.json',
      ])
        ownedStat(join(runRoot, name));
    }
    if (
      status.exitCode === 0 &&
      (status.stopped !== null ||
        qualification.offlineEvaluation?.offlinePassed !== true ||
        qualification.nestedRetirement !== 'confirmed' ||
        !same(
          journal.phases.map((p) => p.phase),
          ['setup', 'version', 'native', 'setup-negative', 'failure-consumer'],
        ) ||
        journal.phases.some(
          (p) =>
            p.exitCode !== 0 ||
            p.timedOut ||
            p.spawnError ||
            p.recording?.error,
        ))
    )
      refuse();
    if (status.exitCode === 1 && typeof status.stopped !== 'string') refuse();
    const actual = indexRoot(runRoot, {
      nestedRetirement: index.nestedRetirement,
    });
    // Compare all filesystem metadata and bound journal/status content. Symlink
    // retention labels remain evidence, not permission to follow their targets.
    const comparable = (entries) =>
      entries
        .map(({ retained, ...entry }) => entry)
        .sort((a, b) => a.path.localeCompare(b.path, 'en'));
    if (
      !same(comparable(index.entries), comparable(actual.entries)) ||
      index.nestedRetirement !== qualification.nestedRetirement ||
      status.indexSemanticsSHA256 !== indexSemanticsSHA256(index)
    )
      refuse();
    return status;
  } catch (error) {
    throw new Error('existing-run-unverified-or-incomplete: ' + error.message, {
      cause: error,
    });
  }
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
        entries.push({
          path: rel,
          type: 'link',
          target,
          owned,
          retained,
          dev: stat.dev,
          ino: stat.ino,
          uid: stat.uid,
          mode: stat.mode & 0o777,
          size: stat.size,
          role: rel.startsWith('fixtures/')
            ? 'fixture'
            : rel.startsWith('retained/')
              ? 'retained'
              : 'entry',
        });
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
        ...(stat.isFile() && COMPLETION_HASH_PATHS.has(rel)
          ? { sha256: hashFile(path) }
          : {}),
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
