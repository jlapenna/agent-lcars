import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

// Admission-to-launch gating for a bounded local verification phase. #2511
// measured the failure on the genuine Laptop publication path: one composed
// command ran the envelope assertion and then a read-only occupancy probe in
// the same shell. The assertion refused the actual envelope — planned 2 CPU /
// 2 Gi over 9.1 CPU / 22656 Mi of native demand against 23833168 Ki of
// post-reserve memory, after a new 2 Gi control worker arrived — and exited
// nonzero, while the trailing read-only probe exited 0 and became the shell's
// result. The caller read that aggregate zero as approval and launched its own
// normal publication and setup phase from an earlier accepted snapshot: unit
// `lcars-root-inbox-publication-01a11f2d` (invocation
// `4233bb705590459fb47d5d9c7aa5e51d`) ran 19.103 s wall with 18.591 CPU seconds
// and 371.6 MiB/no swap before SIGTERM during dependency setup, and systemd
// reported the requested stop as successful. Guidance text cannot see that
// boundary, so these cases drive the real composition and its consumer against
// an inert owned workload and retain every numeric exit.
const run = promisify(execFile);

const bash = '/bin/bash';
const envProgram = '/usr/bin/env';
const systemdRun = '/usr/bin/systemd-run';

// The admission's own refused code: neither 1 nor any later command's status,
// so an assertion can only pass on the numeric result the check returned.
const REFUSED_EXIT = 3;
// The consumer's explicit refused code when nothing was returned to gate on.
const NO_RESULT_EXIT = 65;

// The recorded host capacity and the two occupancy rows around the turnover.
const POST_RESERVE_MEMORY_KI = 23833168;
const PLANNED_MEMORY_KI = 2_097_152;
const NATIVE_MEMORY_MIB = {
  // 23833168 - 20608*1024 = 2731088 Ki of slack, so the unchanged planned
  // envelope genuinely fit here: this is the snapshot the earlier receipt
  // qualified.
  fit: 20_608,
  // The same host after the new 2 Gi control worker arrived: 23833168 -
  // 22656*1024 = 633424 Ki, which cannot carry a 2097152 Ki request.
  refused: 22_656,
};

// Qualification for the planned envelope against the current rows.
const admissionScript = [
  '#!/bin/bash',
  'set -uo pipefail',
  'post=$(sed -n "s/^post_reserve_memory_ki=//p" "$LCARS_ROWS_FILE")',
  'native=$(sed -n "s/^native_memory_mib=//p" "$LCARS_ROWS_FILE")',
  'read -r planned < "$LCARS_PLANNED_FILE"',
  'available=$(( post - native * 1024 ))',
  'if (( available < planned )); then',
  '  printf "admission=refused available=%sKi planned=%sKi\\n" "$available" "$planned" >&2',
  `  exit ${REFUSED_EXIT}`,
  'fi',
  'printf "admission=accepted available=%sKi planned=%sKi\\n" "$available" "$planned"',
  '',
].join('\n');

// A legitimate read-only observation: it reads the rows, records what it saw,
// and exits 0. The probe is never the defect; mistaking its status for the
// admission verdict is.
const probeScript = [
  '#!/bin/bash',
  'set -uo pipefail',
  'cat "$LCARS_ROWS_FILE" > "$LCARS_PROBE_FILE"',
  'printf "probe=observed\\n" >> "$LCARS_PROBE_FILE"',
  '',
].join('\n');

// The compositions the incident turned on. Neither enables `set -e`: the
// recorded caller ran both commands in one shell and read only the aggregate
// status, which is what let the trailing probe carry the verdict.
const compositionScript = [
  '#!/bin/bash',
  'set -uo pipefail',
  'case "$LCARS_COMPOSITION" in',
  '  propagated)',
  '    # Capture the admission status at once, run the read-only probe after',
  '    # it, and return the captured numeric result explicitly.',
  `    ${bash} "$LCARS_ADMISSION"`,
  '    admission_exit=$?',
  `    ${bash} "$LCARS_PROBE"`,
  '    printf "admission-exit=%d\\n" "$admission_exit"',
  '    exit "$admission_exit"',
  '    ;;',
  '  probe-first)',
  '    # Sequence accident: the trailing admission status becomes the',
  '    # aggregate, and nothing is returned for the caller to gate on.',
  `    ${bash} "$LCARS_PROBE"`,
  `    ${bash} "$LCARS_ADMISSION"`,
  '    ;;',
  '  masked)',
  '    # Recorded failure: the read-only probe runs last, so its zero is the',
  '    # shell result and the refusal is never returned.',
  `    ${bash} "$LCARS_ADMISSION"`,
  `    ${bash} "$LCARS_PROBE"`,
  '    ;;',
  'esac',
  '',
].join('\n');

// The consumer: launch only on the affirmative current admission result this
// run received. An aggregate zero that returned no result is held, and an
// earlier receipt is never consulted.
const callerScript = [
  '#!/bin/bash',
  'set -uo pipefail',
  `report=$(${bash} "$LCARS_QUALIFICATION")`,
  'aggregate=$?',
  'admission_exit=$(printf "%s\\n" "$report" | sed -n "s/^admission-exit=//p" | tail -n1)',
  'if [[ "$admission_exit" == "0" ]]; then',
  '  printf "gate=launch aggregate=%d admission-exit=0\\n" "$aggregate"',
  `  ${bash} "$LCARS_WORKLOAD"`,
  '  exit 0',
  'fi',
  'if [[ -z "$admission_exit" ]]; then',
  '  printf "gate=hold aggregate=%d admission-exit=absent\\n" "$aggregate"',
  `  exit ${NO_RESULT_EXIT}`,
  'fi',
  'printf "gate=hold aggregate=%d admission-exit=%s\\n" "$aggregate" "$admission_exit"',
  'exit "$admission_exit"',
  '',
].join('\n');

// The owned workload: only a launched phase may create its witness.
const workloadScript = [
  '#!/bin/bash',
  'set -euo pipefail',
  'printf "setup-phase-started\\n" > "$LCARS_WITNESS"',
  '',
].join('\n');

type Outcome = { exit: number; stdout: string; stderr: string };

type Phase = {
  directory: string;
  caller: string;
  witness: string;
  probeFile: string;
  rowsFile: string;
  receipt: string;
  environment: Record<string, string>;
};

type PhaseCase = {
  label: string;
  composition: 'propagated' | 'probe-first' | 'masked';
  rows: 'fit' | 'refused';
  receipt: boolean;
  aggregate: number;
  exit: number;
  gate: 'launch' | 'hold';
  admissionExit: string;
  witness: boolean;
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

function rowsContent(state: 'fit' | 'refused'): string {
  return `post_reserve_memory_ki=${POST_RESERVE_MEMORY_KI}\nnative_memory_mib=${NATIVE_MEMORY_MIB[state]}\n`;
}

const acceptedReceipt = `admission-exit=0 rows=native_memory_mib=${NATIVE_MEMORY_MIB.fit}\n`;

async function fixture(
  testCase: PhaseCase,
  extra: Record<string, string>,
): Promise<Phase> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lcars-admission-'));
  await mkdir(directory, { recursive: true });
  const script = (name: string, body: string) =>
    writeFile(path.join(directory, name), body, { mode: 0o700 });
  const rowsFile = path.join(directory, 'occupancy-rows.txt');
  const phase: Phase = {
    directory,
    caller: path.join(directory, 'caller.sh'),
    witness: path.join(directory, 'setup-witness'),
    probeFile: path.join(directory, 'probe-observation.txt'),
    rowsFile,
    receipt: path.join(directory, 'earlier-receipt.txt'),
    environment: {
      LCARS_ADMISSION: path.join(directory, 'admission.sh'),
      LCARS_PROBE: path.join(directory, 'probe.sh'),
      LCARS_WORKLOAD: path.join(directory, 'workload.sh'),
      LCARS_QUALIFICATION: path.join(directory, 'qualification.sh'),
      LCARS_COMPOSITION: testCase.composition,
      LCARS_ROWS_FILE: rowsFile,
      LCARS_PLANNED_FILE: path.join(directory, 'planned.txt'),
      LCARS_PROBE_FILE: path.join(directory, 'probe-observation.txt'),
      LCARS_WITNESS: path.join(directory, 'setup-witness'),
      ...extra,
    },
  };
  await writeFile(rowsFile, rowsContent(testCase.rows), { mode: 0o600 });
  await writeFile(
    path.join(directory, 'planned.txt'),
    `${PLANNED_MEMORY_KI}\n`,
    { mode: 0o600 },
  );
  await script('admission.sh', admissionScript);
  await script('probe.sh', probeScript);
  await script('workload.sh', workloadScript);
  await script('qualification.sh', compositionScript);
  await script('caller.sh', callerScript);
  if (testCase.receipt) {
    // The earlier accepted snapshot, retained as its own receipt: it must be
    // neither consulted nor rewritten by the current launch decision.
    await writeFile(phase.receipt, acceptedReceipt, { mode: 0o600 });
  }
  return phase;
}

function reportedGate(outcome: Outcome): Record<string, string> {
  const line = /^gate=(\S+) aggregate=(\S+) admission-exit=(\S+)$/m.exec(
    outcome.stdout,
  );
  return line
    ? { gate: line[1], aggregate: line[2], admissionExit: line[3] }
    : {};
}

// Probe the real supervisor: a transient user service, never the caller's
// shell. A host without a reachable manager skips those cases visibly instead
// of letting a shell fixture stand in for supervised proof.
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

// The supervised caller receives only what the fixture qualified: the manager's
// environment, not the launching shell's.
async function supervised(phase: Phase): Promise<Outcome> {
  const setenv = Object.entries({
    ...phase.environment,
    PATH: '/usr/bin:/bin',
  }).map(([key, value]) => `--setenv=${key}=${value}`);
  return launch(
    systemdRun,
    [
      '--user',
      '--quiet',
      '--collect',
      '--pipe',
      '--wait',
      '--description=lcars-2511-refused-admission-fails-closed',
      `--working-directory=${process.cwd()}`,
      '--property=RuntimeMaxSec=60',
      ...setenv,
      bash,
      phase.caller,
    ],
    process.cwd(),
  );
}

// Always-runnable companion at the same boundary: no login shell and no
// inherited environment, so the child sees exactly what was qualified. It
// complements the supervised cases; it does not replace them.
async function childEnvironment(phase: Phase): Promise<Outcome> {
  const environment = Object.entries({
    ...phase.environment,
    PATH: '/usr/bin:/bin',
    HOME: os.homedir(),
  }).map(([key, value]) => `${key}=${value}`);
  return launch(
    envProgram,
    ['-i', ...environment, bash, phase.caller],
    process.cwd(),
  );
}

// Every case asserts exit, gate report, witness, probe observation, and that
// the read-only probe left the rows and any earlier receipt untouched: a case
// may not pass by skipping the evidence it failed to produce.
const phaseCases: PhaseCase[] = [
  {
    label: 'accepted envelope under a propagated result',
    composition: 'propagated',
    rows: 'fit',
    receipt: false,
    aggregate: 0,
    exit: 0,
    gate: 'launch',
    admissionExit: '0',
    witness: true,
  },
  {
    label: 'refused admission propagated after a read-only probe',
    composition: 'propagated',
    rows: 'refused',
    receipt: false,
    aggregate: REFUSED_EXIT,
    exit: REFUSED_EXIT,
    gate: 'hold',
    admissionExit: String(REFUSED_EXIT),
    witness: false,
  },
  {
    // The recorded shape: the aggregate really is zero, which is precisely why
    // an aggregate status cannot authorize the owned workload.
    label: 'refused admission masked by a trailing read-only probe',
    composition: 'masked',
    rows: 'refused',
    receipt: false,
    aggregate: 0,
    exit: NO_RESULT_EXIT,
    gate: 'hold',
    admissionExit: 'absent',
    witness: false,
  },
  {
    // Ordering is not the contract. Here the refusal does reach the aggregate
    // by accident of sequence, yet nothing was returned to gate on, so the
    // consumer still holds: the decision never rests on the aggregate status.
    label: 'refused admission with the probe run first',
    composition: 'probe-first',
    rows: 'refused',
    receipt: false,
    aggregate: REFUSED_EXIT,
    exit: NO_RESULT_EXIT,
    gate: 'hold',
    admissionExit: 'absent',
    witness: false,
  },
  {
    label: 'refused admission against an earlier accepted receipt',
    composition: 'propagated',
    rows: 'refused',
    receipt: true,
    aggregate: REFUSED_EXIT,
    exit: REFUSED_EXIT,
    gate: 'hold',
    admissionExit: String(REFUSED_EXIT),
    witness: false,
  },
];

async function readFile(target: string): Promise<string> {
  return fs.promises.readFile(target, 'utf8');
}

async function assertPhase(
  phase: Phase,
  testCase: PhaseCase,
  outcome: Outcome,
): Promise<Record<string, string>> {
  expect(outcome.exit).toBe(testCase.exit);
  const gate = reportedGate(outcome);
  expect(gate).toEqual({
    gate: testCase.gate,
    aggregate: String(testCase.aggregate),
    admissionExit: testCase.admissionExit,
  });
  expect(await exists(phase.witness)).toBe(testCase.witness);
  expect(await readFile(phase.probeFile)).toContain('probe=observed');
  expect(await readFile(phase.rowsFile)).toBe(rowsContent(testCase.rows));
  if (testCase.receipt) {
    expect(await readFile(phase.receipt)).toBe(acceptedReceipt);
  }
  return gate;
}

it.runIf(supervisorAvailable).each(phaseCases)(
  'gates $label under the real transient user unit',
  async (testCase) => {
    const phase = await fixture(testCase, {});
    try {
      const outcome = await supervised(phase);
      expect(await assertPhase(phase, testCase, outcome)).toHaveProperty(
        'gate',
        testCase.gate,
      );
    } finally {
      await rm(phase.directory, { recursive: true, force: true });
    }
  },
  120_000,
);

it.each(phaseCases)(
  'gates $label in a child environment with no inherited PATH',
  async (testCase) => {
    const phase = await fixture(testCase, {});
    try {
      const outcome = await childEnvironment(phase);
      expect(await assertPhase(phase, testCase, outcome)).toHaveProperty(
        'gate',
        testCase.gate,
      );
    } finally {
      await rm(phase.directory, { recursive: true, force: true });
    }
  },
  120_000,
);
