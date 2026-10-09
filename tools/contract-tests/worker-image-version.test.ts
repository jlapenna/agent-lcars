import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { imageScenario } from '../probes/qualification-scenario.mjs';
import { imageVersion } from '../probes/qualification-version.mjs';

// Real subprocesses model independently surviving daemon workloads. A command
// log alone cannot prove that cleanup stopped the owned workload.
for (const kind of ['version', 'scenario']) {
  it.each([
    'success',
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
hang() { while :; do sleep 1 & wait $!; done; }
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
        let value;
        const started = performance.now();
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
                  },
                );
        } catch {
          failed = true;
        }
        const expectedFailure =
          mode !== 'success' &&
          !(
            kind === 'version' &&
            ['copy-failure', 'missing-native-diagnostics'].includes(mode)
          );
        expect(failed).toBe(expectedFailure);
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
        const expectedKill = ![
          'success',
          'create-disconnect',
          'copy-failure',
          'missing-native-diagnostics',
        ].includes(mode);
        expect(calls.some((call) => call[0] === 'kill')).toBe(expectedKill);
        expect(performance.now() - started).toBeLessThan(5000);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    10000,
  );
}

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
          killing = JSON.parse(readFileSync(statePath, 'utf8')).killing;
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
