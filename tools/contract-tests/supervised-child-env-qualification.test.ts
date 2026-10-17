import { execFile } from 'node:child_process';
import fs from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

// Qualification of the environment a supervised verification phase actually
// receives. #2525 measured a supervised source-publication unit exit 127 at
// tools/setup-worktree.sh line 22 (`pnpm: command not found`) after 207 ms of
// wall time: the phase had been qualified with `command -v` in an SSH login
// shell, while the transient unit started in the manager's environment and
// never saw the version-manager bins that shell resolved. A login-shell lookup,
// or a fixture that only re-reads the guidance, cannot see that boundary, so
// these cases launch an inert phase and assert what its own child environment
// resolved, retaining numeric exits.
const run = promisify(execFile);

const bash = '/bin/bash';
const envProgram = '/usr/bin/env';
const systemdRun = '/usr/bin/systemd-run';
const packageManager: unknown = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).packageManager;
const pnpmPin =
  typeof packageManager === 'string'
    ? /^pnpm@([^+]+)(?:\+.*)?$/.exec(packageManager)
    : null;
if (!pnpmPin) throw new Error('Repository packageManager must pin pnpm');
const pinnedPnpmVersion = pnpmPin[1];

// The phase body mirrors what a real supervised phase must do first: report the
// toolchain the child itself resolved, then start dependent work. The tool
// invocations are direct rather than `command -v` lookups so an absent
// toolchain carries the true shell exit 127 instead of a lookup's exit 1, and
// each result is captured through an assignment because a command substitution
// used as a command argument keeps the enclosing command's exit status and
// would let `set -e` walk past a missing toolchain. The witness stands in for
// setup: only a child that resolved both binaries may create it.
const phaseScript = [
  '#!/bin/bash',
  'set -euo pipefail',
  'nodeVersion="$(node --version)"',
  'nodePath="$(command -v node)"',
  'printf "node-path=%s\\nnode-version=%s\\n" "$nodePath" "$nodeVersion"',
  'pnpmVersion="$(pnpm --version)"',
  'pnpmPath="$(command -v pnpm)"',
  'printf "pnpm-path=%s\\npnpm-version=%s\\n" "$pnpmPath" "$pnpmVersion"',
  ': > "$LCARS_PHASE_WITNESS"',
  '',
].join('\n');

type Outcome = { exit: number; stdout: string; stderr: string };

type Phase = {
  directory: string;
  script: string;
  witness: string;
  qualifiedPath: string;
  unqualifiedPath: string;
  nodeOnlyPath: string;
  expectedNodePath: string;
  expectedPnpmPath: string;
  pnpmVersion: string;
};

type PhaseCase = {
  label: string;
  key: 'qualifiedPath' | 'unqualifiedPath' | 'nodeOnlyPath';
  exit: number;
  witness: boolean;
  receipt: string;
};

async function launch(
  command: string,
  args: string[],
  cwd: string,
): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(command, args, {
      cwd,
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { exit: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      exit: typeof failure.code === 'number' ? failure.code : -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

// The already-qualified stable Node installation bin, resolved through any
// symlink the launching shell happened to use, plus the bin that carries the
// matching package manager.
function qualifiedBins(): string[] {
  const directories = new Set<string>([
    path.dirname(fs.realpathSync(process.execPath)),
  ]);
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    try {
      fs.accessSync(path.join(directory, 'pnpm'), fs.constants.X_OK);
      directories.add(directory);
      break;
    } catch {
      // Not the directory carrying the package manager; keep looking.
    }
  }
  return [...directories];
}

async function fixture(): Promise<Phase> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lcars-child-env-'));
  const script = path.join(directory, 'phase.sh');
  const emptyBin = path.join(directory, 'empty-bin');
  const witness = path.join(directory, 'setup-witness');
  const nodeOnlyBin = path.join(directory, 'node-only-bin');
  await mkdir(nodeOnlyBin);
  await symlink(
    fs.realpathSync(process.execPath),
    path.join(nodeOnlyBin, 'node'),
  );
  const bins = qualifiedBins();
  const expectedNodePath = path.join(bins[0], 'node');
  const expectedPnpmPath = bins
    .map((bin) => path.join(bin, 'pnpm'))
    .find((candidate) => fs.existsSync(candidate));
  if (!expectedPnpmPath)
    throw new Error('Qualified pnpm executable is unavailable');
  await mkdir(emptyBin);
  await writeFile(script, phaseScript, { mode: 0o700 });
  return {
    directory,
    script,
    witness,
    // Standard utilities come after the selected toolchain. A real pnpm
    // launcher may be a shell script (pnpm/action-setup invokes dirname, sed,
    // and uname); those resolve from the system bins only when present, while
    // the qualified bins stay first so Node/pnpm precedence is preserved.
    qualifiedPath: [...bins, '/usr/bin', '/bin', emptyBin].join(path.delimiter),
    nodeOnlyPath: nodeOnlyBin,
    expectedNodePath,
    expectedPnpmPath,
    pnpmVersion: pinnedPnpmVersion,
    unqualifiedPath: emptyBin,
  };
}

function reportedToolchain(outcome: Outcome): Record<string, string> {
  return Object.fromEntries(
    [
      ...outcome.stdout.matchAll(/^((?:node|pnpm)-(?:version|path))=(.+)$/gm),
    ].map((match) => [match[1], match[2]]),
  );
}

// Both cases assert exit, witness, and the child's own report unconditionally:
// a case may not pass by skipping the receipt it failed to produce.
const phaseCases: PhaseCase[] = [
  {
    label: 'qualified',
    key: 'qualifiedPath',
    exit: 0,
    witness: true,
    receipt: `node-version=v${process.versions.node}`,
  },
  {
    label: 'missing Node',
    key: 'unqualifiedPath',
    exit: 127,
    witness: false,
    receipt: 'node: command not found',
  },
  {
    label: 'Node available but pnpm missing',
    key: 'nodeOnlyPath',
    exit: 127,
    witness: false,
    receipt: 'pnpm: command not found',
  },
];

function expectedToolchain(
  phase: Phase,
  testCase: PhaseCase,
): Record<string, string> {
  if (testCase.key === 'unqualifiedPath') return {};
  const node = {
    'node-path':
      testCase.key === 'nodeOnlyPath'
        ? path.join(phase.nodeOnlyPath, 'node')
        : phase.expectedNodePath,
    'node-version': `v${process.versions.node}`,
  };
  return testCase.key === 'nodeOnlyPath'
    ? node
    : {
        ...node,
        'pnpm-path': phase.expectedPnpmPath,
        'pnpm-version': phase.pnpmVersion,
      };
}

// Probe the real supervisor: a transient user service, never the caller's shell.
// A host without a reachable manager skips those cases visibly instead of
// letting a shell fixture stand in for supervised proof.
const supervisorProbe = await launch(
  systemdRun,
  [
    '--user',
    '--quiet',
    '--collect',
    '--pipe',
    '--wait',
    '--property=RuntimeMaxSec=30',
    '/bin/true',
  ],
  process.cwd(),
);
const supervisorAvailable =
  supervisorProbe.exit === 0 && fs.existsSync(systemdRun);

async function supervised(phase: Phase, pathValue: string): Promise<Outcome> {
  return launch(
    systemdRun,
    [
      '--user',
      '--quiet',
      '--collect',
      '--pipe',
      '--wait',
      '--description=lcars-2525-child-env-qualification',
      `--working-directory=${process.cwd()}`,
      '--property=RuntimeMaxSec=60',
      // Literal values: a transient service inherits the manager's environment,
      // never the launcher's. A `$PATH` in this assignment would remain literal.
      `--setenv=PATH=${pathValue}`,
      `--setenv=LCARS_PHASE_WITNESS=${phase.witness}`,
      bash,
      phase.script,
    ],
    process.cwd(),
  );
}

// Always-runnable companion at the same child-environment boundary: no login
// shell and no inherited PATH, so the child sees exactly what was qualified.
// It complements the supervised cases; it does not replace them.
async function childEnvironment(
  phase: Phase,
  pathValue: string,
): Promise<Outcome> {
  return launch(
    envProgram,
    [
      '-i',
      `PATH=${pathValue}`,
      `HOME=${os.homedir()}`,
      `LCARS_PHASE_WITNESS=${phase.witness}`,
      bash,
      phase.script,
    ],
    process.cwd(),
  );
}

it.runIf(supervisorAvailable).each(phaseCases)(
  'starts $label setup under the real transient user unit',
  async (testCase) => {
    const phase = await fixture();
    try {
      const outcome = await supervised(phase, phase[testCase.key]);
      expect(
        outcome.exit,
        `${testCase.label} supervised child:\n${outcome.stdout}\n${outcome.stderr}`,
      ).toBe(testCase.exit);
      expect(await exists(phase.witness)).toBe(testCase.witness);
      expect(reportedToolchain(outcome)).toEqual(
        expectedToolchain(phase, testCase),
      );
      expect(`${outcome.stdout}\n${outcome.stderr}`).toContain(
        testCase.receipt,
      );
    } finally {
      await rm(phase.directory, { recursive: true, force: true });
    }
  },
  120_000,
);

it.each(phaseCases)(
  'starts $label setup in a child environment with no inherited PATH',
  async (testCase) => {
    const phase = await fixture();
    try {
      const outcome = await childEnvironment(phase, phase[testCase.key]);
      expect(
        outcome.exit,
        `${testCase.label} direct child:\n${outcome.stdout}\n${outcome.stderr}`,
      ).toBe(testCase.exit);
      expect(await exists(phase.witness)).toBe(testCase.witness);
      expect(reportedToolchain(outcome)).toEqual(
        expectedToolchain(phase, testCase),
      );
      expect(`${outcome.stdout}\n${outcome.stderr}`).toContain(
        testCase.receipt,
      );
    } finally {
      await rm(phase.directory, { recursive: true, force: true });
    }
  },
  120_000,
);
