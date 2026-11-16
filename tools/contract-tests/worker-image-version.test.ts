import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { runImageContainer } from '../probes/qualification-container.mjs';
import { imageScenario } from '../probes/qualification-scenario.mjs';
import { imageVersion } from '../probes/qualification-version.mjs';

// Real subprocesses model independently surviving daemon workloads. A command
// log alone cannot prove that cleanup stopped the owned workload.
for (const kind of ['version', 'scenario']) {
  it.each([
    'success',
    'slow-cleanup-inspections',
    'hang',
    'ignored-sigterm',
    'inherited-pipe',
    'disconnect',
    'bad-json',
    'inspect-failure',
    'hung-inspect',
    'partial-state',
    'kill-no-effect',
    'cleanup-inspect-failure',
    'cleanup-only-failure',
    'create-disconnect',
    'copy-failure',
    'log-write-failure',
    'missing-native-diagnostics',
  ])(
    'bounds ' + kind + ' container lifetime on %s',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'policy-container-test-'));
      const docker = join(root, 'docker.mjs');
      const statePath = join(root, 'state.json');
      const callsPath = join(root, 'calls.jsonl');
      const version = '/usr/local/bin/codex\ncodex-cli fixture';
      // A shell fake starts in milliseconds even on a saturated runner; a Node
      // fake costs hundreds there, the same order as the cleanup budgets
      // under test, so a slow host could exhaust them before the fake ran.
      writeFileSync(
        docker,
        `#!/usr/bin/env bash
mode=${JSON.stringify(mode)}
kind=${JSON.stringify(kind)}
state=${JSON.stringify(statePath)}
json_args=$(printf ',"%s"' "$@")
printf '[%s]\n' "\${json_args#,}" >> ${JSON.stringify(callsPath)}
running=false; inspections=0; removed=false
if [ "$1" != create ]; then . "$state.sh"; fi
save() {
  printf 'running=%s inspections=%s removed=%s\n' "$running" "$inspections" "$removed" > "$state.sh"
  printf '{"Running":%s,"ExitCode":0,"inspections":%s,"removed":%s}' "$running" "$inspections" "$removed" > "$state"
}
hang() { : > ${JSON.stringify(join(root, 'hang.'))}$$; while :; do sleep 1 & wait $!; done; }
in_mode() { case " $* " in *" $mode "*) return 0 ;; esac; return 1; }
case "$1" in
create) save; echo "$3"; [ "$mode" != create-disconnect ] || exit 1 ;;
start)
  running=true; save
  [ "$mode" != ignored-sigterm ] || trap '' TERM
  if in_mode hang ignored-sigterm; then hang; fi
  if [ "$mode" = inherited-pipe ]; then (trap '' TERM; hang) & exit 0; fi
  [ "$mode" != disconnect ] || exit 1
  in_mode log-write-failure inspect-failure hung-inspect partial-state kill-no-effect cleanup-inspect-failure bad-json || running=false
  save
  if [ "$mode" = bad-json ] && [ "$kind" = scenario ]; then echo '{partial'
  elif [ "$kind" = version ]; then printf '%b\n' ${JSON.stringify(version)}
  elif [ "$mode" = missing-native-diagnostics ]; then echo '{"passed":true,"diagnosticsDirectory":"/tmp/lcars-image-probe-abc","nativeReport":{}}'
  else echo '{"passed":true,"diagnosticsDirectory":"/tmp/lcars-image-probe-abc","nativeReport":{"evidenceDirectory":"/tmp/lcars-native-abc"}}'
  fi ;;
inspect)
  inspections=$((inspections + 1)); save
  # Collection already proved a stopped exit. The first cleanup inspection
  # and the first post-kill inspection deliberately give no answer. Finite
  # cleanup must terminate its owned name, retry stopped-state readback,
  # then remove it while preserving the already validated result.
  if [ "$mode" = slow-cleanup-inspections ] && { [ "$inspections" -eq 2 ] || [ "$inspections" -eq 3 ]; }; then hang; fi
  if [ "$mode" = hung-inspect ] && [ "$inspections" -le 2 ]; then trap '' TERM; hang; fi
  if { [ "$mode" = inspect-failure ] && [ "$inspections" -le 2 ]; } || [ "$mode" = cleanup-inspect-failure ] || { [ "$mode" = cleanup-only-failure ] && [ "$inspections" -gt 1 ]; }; then exit 1; fi
  if { [ "$mode" = partial-state ] && [ "$inspections" -le 2 ]; } || { [ "$mode" = bad-json ] && [ "$kind" = version ] && [ "$inspections" -eq 1 ]; }; then echo '{partial'
  else cat "$state"; echo
  fi ;;
kill) [ "$mode" = kill-no-effect ] || running=false; save ;;
cp) [ "$mode" != copy-failure ] || exit 1 ;;
rm) [ "$running" = false ] || exit 3; removed=true; save ;;
*) exit 2 ;;
esac
`,
        { mode: 0o700 },
      );
      try {
        let failed = false;
        let failure: unknown;
        let value;
        const started = performance.now();
        // Time is injected so a starved CI worker cannot change the outcome
        // (#3395). The cleanup budget never advances; it has its own test
        // below. A client's deadline expires exactly when the fake declares
        // it will never answer (hang), and never for a client that answers,
        // however slowly the host runs it.
        const now = () => 0;
        const clientDeadline = (
          child: { pid?: number },
          expire: () => void,
        ): (() => void) => {
          const declared = join(root, 'hang.' + child.pid);
          const poll = setInterval(() => {
            if (!existsSync(declared)) return;
            clearInterval(poll);
            expire();
          }, 5);
          return () => clearInterval(poll);
        };
        try {
          value =
            kind === 'version'
              ? await imageVersion(
                  ['fixture'],
                  mode === 'log-write-failure'
                    ? join(root, 'missing-output')
                    : root,
                  1000,
                  docker,
                  {
                    commandTimeout: 1000,
                    cleanupTimeout: 1500,
                    now,
                    clientDeadline,
                  },
                )
              : await imageScenario(
                  ['fixture'],
                  mode === 'log-write-failure'
                    ? join(root, 'missing-output')
                    : root,
                  'native',
                  {
                    docker,
                    timeout: 1000,
                    cleanupTimeout: 1500,
                    commandTimeout: 1000,
                    now,
                    clientDeadline,
                  },
                );
        } catch (error) {
          failed = true;
          failure = error;
        }
        const expectedFailure =
          !['success', 'slow-cleanup-inspections'].includes(mode) &&
          !(
            kind === 'version' &&
            ['copy-failure', 'missing-native-diagnostics'].includes(mode)
          );
        expect(
          failed,
          JSON.stringify({
            error: failure === undefined ? undefined : String(failure),
            cause:
              failure instanceof Error && failure.cause !== undefined
                ? String(failure.cause)
                : undefined,
            errors:
              failure instanceof AggregateError
                ? failure.errors.map(String)
                : undefined,
            calls: existsSync(callsPath)
              ? readFileSync(callsPath, 'utf8')
              : undefined,
            state: existsSync(statePath)
              ? readFileSync(statePath, 'utf8')
              : undefined,
          }),
        ).toBe(expectedFailure);
        expect(value).toEqual(
          expectedFailure
            ? undefined
            : kind === 'version'
              ? version
              : {
                  passed: true,
                  diagnosticsDirectory: '/tmp/lcars-image-probe-abc',
                  nativeReport: { evidenceDirectory: '/tmp/lcars-native-abc' },
                },
        );
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        expect(state.Running).toBe(mode === 'kill-no-effect');
        const expectedRemoval = !expectedFailure;
        expect(state.removed === true).toBe(expectedRemoval);
        const calls = readFileSync(callsPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const requiresKill = ![
          'success',
          'create-disconnect',
          'copy-failure',
          'missing-native-diagnostics',
        ].includes(mode);
        // A stopped workload can still need conservative owned termination
        // when its cleanup inspection is inconclusive; successful collection
        // does not promise that every later subprocess beats a host deadline.
        if (requiresKill)
          expect(calls.some((call) => call[0] === 'kill')).toBe(true);
        if (mode === 'slow-cleanup-inspections') {
          const kill = calls.findIndex((call) => call[0] === 'kill');
          const removal = calls.findIndex((call) => call[0] === 'rm');
          expect(kill).toBeGreaterThan(
            calls.findIndex((call) => call[0] === 'inspect'),
          );
          expect(removal).toBeGreaterThan(kill);
          expect(
            calls
              .slice(kill + 1, removal)
              .some((call) => call[0] === 'inspect'),
          ).toBe(true);
          // The deliberate second inconclusive inspection exercises a real
          // bounded readback retry; extra retries must not invalidate success.
          expect(state.inspections).toBeGreaterThanOrEqual(4);
        }
        expect(performance.now() - started).toBeLessThan(5000);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    10000,
  );
}

// A stopped, collected workload whose daemon answers every call at once.
const writeStoppedDocker = (root: string) => {
  const docker = join(root, 'docker.sh');
  const callsPath = join(root, 'calls.jsonl');
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
json_args=$(printf ',"%s"' "$@")
printf '[%s]\n' "\${json_args#,}" >> ${JSON.stringify(callsPath)}
case "$1" in
create) echo "$3" ;;
start) echo fixture ;;
inspect) echo "$$" > ${JSON.stringify(join(root, 'inspect.pid'))}; echo '{"Running":false,"ExitCode":0}' ;;
rm|kill) ;;
*) exit 2 ;;
esac
`,
    { mode: 0o700 },
  );
  return {
    docker,
    calls: () =>
      readFileSync(callsPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)[0]),
  };
};

it('stops cleanup when its shared budget is exhausted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'policy-budget-test-'));
  try {
    const { docker, calls } = writeStoppedDocker(root);
    // The clock starts the budget, then reads as long past its deadline.
    let reads = 0;
    const failure = await runImageContainer(
      ['fixture'],
      async () => 'collected',
      { docker, cleanupTimeout: 1500, now: () => (reads++ ? 1e9 : 0) },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'Owned container stopped state is unproven',
    );
    expect(String((failure as Error).cause)).toBe(
      'Error: Container cleanup budget exhausted',
    );
    // No cleanup client ran past the budget, so the container is retained.
    expect(calls()).toEqual(['create', 'start']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A worker stalled past a client deadline resumes with that timer due and the
// client's exit and EOF already queued. The timer can then fire before the
// client's close is emitted (#3395). Stall from the check phase until the
// fake has exited (a zombie awaiting reap) and its deadline is due.
it.skipIf(process.platform !== 'linux')(
  'keeps a client that finished before a stalled loop observed its deadline',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'policy-stall-test-'));
    try {
      const { docker, calls } = writeStoppedDocker(root);
      const pidPath = join(root, 'inspect.pid');
      const value = await runImageContainer(
        ['fixture'],
        async (container, _execution, command) => {
          const limit = 50;
          const readback = command(
            ['inspect', '--format', '{{json .State}}', container],
            limit,
          );
          // The client and its deadline timer exist once command() returns.
          const armed = performance.now();
          const exited = () => {
            try {
              const pid = readFileSync(pidPath, 'utf8').trim();
              const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
              return stat.slice(stat.lastIndexOf(')') + 2)[0] === 'Z';
            } catch {
              return false;
            }
          };
          await new Promise<void>((resolve) =>
            setImmediate(() => {
              // Vitest cannot time out a synchronous loop; bound it here.
              while (
                (!exited() || performance.now() - armed <= 2 * limit) &&
                performance.now() - armed < 5000
              ) {
                /* Synchronously stall the event loop like a starved worker. */
              }
              resolve();
            }),
          );
          return JSON.parse(await readback);
        },
        { docker },
      );
      expect(value).toEqual({ Running: false, ExitCode: 0 });
      expect(calls()).toEqual(['create', 'start', 'inspect', 'inspect', 'rm']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  10000,
);

it.each([
  ['version', 'SIGTERM', false],
  ['scenario', 'SIGTERM', false],
  ['version', 'SIGINT', false],
  ['scenario', 'SIGINT', false],
  ['version', 'SIGHUP', false],
  ['scenario', 'SIGHUP', false],
  ['version', 'SIGTERM', true],
  ['scenario', 'SIGTERM', true],
] as const)(
  'stops an owned %s workload on collector %s (interrupt cleanup: %s)',
  async (kind, signal, interruptCleanup) => {
    const root = mkdtempSync(join(tmpdir(), 'policy-interruption-test-'));
    const statePath = join(root, 'state.json');
    const docker = join(root, 'docker.mjs');
    writeFileSync(
      docker,
      `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const path = ${JSON.stringify(statePath)};
let state = args[0] === 'create' ? { Running: false, ExitCode: 0, name: args[2] } : JSON.parse(readFileSync(path, 'utf8'));
const save = () => writeFileSync(path, JSON.stringify(state));
switch (args[0]) {
case 'create': save(); console.log(state.name); break;
case 'start': state.Running = true; save(); process.on('SIGTERM', () => {}); await new Promise(() => setInterval(() => {}, 1000)); break;
case 'inspect': console.log(JSON.stringify(state)); break;
case 'kill':
  if (${JSON.stringify(interruptCleanup)}) { state.killing = true; save(); await new Promise((resolve) => setTimeout(resolve, 200)); }
  state.Running = false; save(); break;
case 'rm': state.removed = true; save(); break;
}
`,
      { mode: 0o700 },
    );
    const helper = new URL(
      '../probes/qualification-' +
        (kind === 'version' ? 'version' : 'scenario') +
        '.mjs',
      import.meta.url,
    ).href;
    const probe = join(root, 'probe.mjs');
    writeFileSync(
      probe,
      `import { ${kind === 'version' ? 'imageVersion' : 'imageScenario'} } from ${JSON.stringify(helper)};
try { await ${kind === 'version' ? `imageVersion(['fixture'], ${JSON.stringify(root)}, 30000, ${JSON.stringify(docker)})` : `imageScenario(['fixture'], ${JSON.stringify(root)}, 'native', { docker: ${JSON.stringify(docker)} })`}; } catch(error) { console.error(error.message); for (const cause of error.errors ?? []) console.error(cause.message); process.exitCode = 1; }
`,
    );
    const child = spawn(process.execPath, [probe], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const exited = new Promise((resolve) =>
      child.on('close', (code, signal) => resolve({ code, signal })),
    );
    try {
      const deadline = performance.now() + 3000;
      let running = false;
      while (!running && performance.now() < deadline) {
        try {
          running = JSON.parse(readFileSync(statePath, 'utf8')).Running;
        } catch {
          /* Await fixture startup. */
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(running).toBe(true);
      child.kill(signal);
      if (interruptCleanup) {
        let killing = false;
        const cleanupDeadline = performance.now() + 1500;
        while (!killing && performance.now() < cleanupDeadline) {
          try {
            killing = JSON.parse(readFileSync(statePath, 'utf8')).killing;
          } catch {
            /* The fixture rewrites state.json in place; a poll can land
               between its truncate and its write under load (#2325 CI). */
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        child.kill('SIGHUP');
        // Assert outside the conditional, together with the daemon readback.
        running = killing;
      }
      expect(running).toBe(true);
      expect(await exited).toEqual({ code: 1, signal: null });
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(state.Running).toBe(false);
      expect(state.removed === true).toBe(false);
      expect(stderr).toContain('failed to attach');
      expect(stderr).not.toContain('container cleanup also failed');
      expect(stderr).toContain(
        'Qualification container retained: ' + state.name,
      );
    } finally {
      child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  },
  10000,
);
