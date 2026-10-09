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
    'missing-native-diagnostics',
  ])(
    'bounds ' + kind + ' container lifetime on %s',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'policy-container-test-'));
      const docker = join(root, 'docker.mjs');
      const statePath = join(root, 'state.json');
      const callsPath = join(root, 'calls.jsonl');
      const version = '/usr/local/bin/codex\ncodex-cli fixture';
      writeFileSync(
        docker,
        `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
const mode = ${JSON.stringify(mode)};
const kind = ${JSON.stringify(kind)};
let state = args[0] === 'create' ? { Running: false, ExitCode: 0, inspections: 0 } : JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state));
switch (args[0]) {
case 'create': save(); console.log(args[2]); if (mode === 'create-disconnect') process.exit(1); break;
case 'start':
  state.Running = true; save();
  if (mode === 'ignored-sigterm') process.on('SIGTERM', () => {});
  if (mode === 'hang' || mode === 'ignored-sigterm') await new Promise(() => setInterval(() => {}, 1000));
  if (mode === 'disconnect') process.exit(1);
  if (!['inspect-failure','hung-inspect','partial-state','kill-no-effect','cleanup-inspect-failure','bad-json'].includes(mode)) state.Running = false;
  save();
  console.log(mode === 'bad-json' && kind === 'scenario' ? '{partial' : kind === 'version' ? ${JSON.stringify(version)} : JSON.stringify({ passed: true, diagnosticsDirectory: '/tmp/lcars-image-probe-abc', nativeReport: mode === 'missing-native-diagnostics' ? {} : { evidenceDirectory: '/tmp/lcars-native-abc' } }));
  break;
case 'inspect':
  state.inspections++; save();
  if (mode === 'hung-inspect' && state.inspections <= 2) { process.on('SIGTERM', () => {}); await new Promise(() => setInterval(() => {}, 1000)); }
  if ((mode === 'inspect-failure' && state.inspections <= 2) || mode === 'cleanup-inspect-failure' || (mode === 'cleanup-only-failure' && state.inspections > 1)) process.exit(1);
  console.log((mode === 'partial-state' && state.inspections <= 2) || (mode === 'bad-json' && kind === 'version' && state.inspections === 1) ? '{partial' : JSON.stringify(state)); break;
case 'kill': if (mode !== 'kill-no-effect') state.Running = false; save(); break;
case 'cp': if (mode === 'copy-failure') process.exit(1); break;
case 'rm': if (state.Running) process.exit(3); state.removed = true; save(); break;
default: process.exit(2);
}
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
              ? await imageVersion(['fixture'], root, 1000, docker, {
                  commandTimeout: 1000,
                  cleanupTimeout: 1500,
                })
              : await imageScenario(['fixture'], root, 'native', {
                  docker,
                  timeout: 1000,
                  cleanupTimeout: 1500,
                  commandTimeout: 1000,
                });
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
        const expectedRemoval =
          kind === 'version'
            ? ![
                'kill-no-effect',
                'cleanup-inspect-failure',
                'cleanup-only-failure',
              ].includes(mode)
            : mode === 'success';
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
  ['version', 'SIGTERM'],
  ['scenario', 'SIGTERM'],
  ['version', 'SIGINT'],
  ['scenario', 'SIGINT'],
])(
  'stops an owned %s workload on collector %s',
  async (kind, signal) => {
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
case 'kill': state.Running = false; save(); break;
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
try { await ${kind === 'version' ? `imageVersion(['fixture'], ${JSON.stringify(root)}, 30000, ${JSON.stringify(docker)}, { cleanupTimeout: 1500 })` : `imageScenario(['fixture'], ${JSON.stringify(root)}, 'native', { docker: ${JSON.stringify(docker)}, cleanupTimeout: 1500 })`}; } catch(error) { console.error(error.message); process.exitCode = 1; }
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
      expect(await exited).toEqual({ code: 1, signal: null });
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(state.Running).toBe(false);
      expect(state.removed === true).toBe(kind === 'version');
      expect(stderr).toContain('failed to attach');
      expect(
        kind === 'scenario'
          ? stderr
          : 'Qualification container retained: ' + state.name,
      ).toContain('Qualification container retained: ' + state.name);
    } finally {
      child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  },
  10000,
);
