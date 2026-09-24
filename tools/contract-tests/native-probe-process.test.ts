// Release operators consume these diagnostics when a native canary times out.
// A completed answer or exited parent must never waive its original deadline.
import { expect, it } from 'vitest';

import {
  recordNativeProcesses,
  runNativeProcess,
} from '../probes/native-process.mjs';

const run = (source: string, timeout = 3000) =>
  runNativeProcess(
    process.execPath,
    ['-e', source],
    process.cwd(),
    {},
    timeout,
  );

it('retains a failed second launch after a successful initial launch', async () => {
  const recorder = recordNativeProcesses(process.execPath);
  await recorder.run(['-e', 'console.log("initial")'], process.cwd(), {}, 3000);
  await recorder.run(
    ['-e', 'setInterval(() => {}, 1000)'],
    process.cwd(),
    {},
    1000,
  );
  expect(recorder.executions).toHaveLength(2);
  expect(recorder.executions[0]).toMatchObject({
    launch: 1,
    code: 0,
    timedOut: false,
  });
  expect(recorder.executions[1]).toMatchObject({
    launch: 2,
    code: null,
    timedOut: true,
    timeoutMs: 1000,
  });
  expect(recorder.executions[1].atTimeout).toBeDefined();
  expect(recordNativeProcesses(process.execPath).executions).toEqual([]);
});

it('records normal native exit and bounded output without changing success', async () => {
  const result = await run(
    'process.stdout.write("done"); process.stderr.write("detail")',
  );
  expect(result).toMatchObject({
    code: 0,
    timedOut: false,
    stdout: 'done',
    stderr: 'detail',
  });
  expect(result.diagnostics.exit).toMatchObject({ code: 0, signal: null });
  expect(result.diagnostics.firstStdoutMs).toEqual(expect.any(Number));
  expect(result.diagnostics.firstStderrMs).toEqual(expect.any(Number));
  expect(result.diagnostics.atTimeout).toBeUndefined();
});

it('retains a timeout after a printed answer and captures process state', async () => {
  const result = await run(
    'console.log("done"); setInterval(() => {}, 1000)',
    1000,
  );
  expect(result).toMatchObject({
    code: null,
    timedOut: true,
    stdout: 'done\n',
  });
  expect(result.diagnostics.timeoutMs).toBe(1000);
  expect(result.diagnostics.exit.signal).toBe('SIGKILL');
  expect(result.diagnostics.atTimeout.elapsedMs).toBeGreaterThanOrEqual(990);
  expect(result.diagnostics.atTimeout).toHaveProperty('processState');
  expect(result.diagnostics.atTimeout.pressure).toHaveProperty('io');
});

it('distinguishes an exited parent with inherited pipes without accepting it', async () => {
  const result = await run(
    `
    require('node:child_process').spawn(process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'inherit'});
    process.exit(0);
  `,
    1000,
  );
  expect(result).toMatchObject({ code: 0, timedOut: true });
  expect(result.diagnostics.exit).toMatchObject({ code: 0, signal: null });
  expect(result.diagnostics.exit.elapsedMs).toBeLessThan(
    result.diagnostics.atTimeout.elapsedMs,
  );
});

it('reports a failed launch without pretending it timed out', async () => {
  const result = await runNativeProcess(
    '/nonexistent/lcars-native-probe',
    [],
    process.cwd(),
    {},
    1000,
  );
  expect(result).toMatchObject({ code: null, timedOut: false });
  expect(result.diagnostics.spawnError).toBe('ENOENT');
  expect(result.diagnostics.exit).toBeNull();
});
