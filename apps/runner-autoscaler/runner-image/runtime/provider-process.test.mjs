/* eslint-disable vitest/no-import-node-test -- required runner-image shell suite runs this test with node --test, matching neighboring image tests. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const supervisor = new URL('./provider-process.mjs', import.meta.url).pathname;
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'provider-process-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'report');
  await writeFile(path.join(dir, 'curl'), '#!/bin/sh\ncat > "$REPORT_LOG"\n', {
    mode: 0o700,
  });
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    REPORT_LOG: log,
    LCARS_RUN_ID: 'octo/example#42/r1',
    LCARS_RUN_TOKEN: 'private-token',
    LCARS_CONSOLE_URL: 'https://console.example',
  };
  return { dir, log, env };
}
function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [supervisor, ...args], { env });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
test('reports successful spawn once and preserves nonzero workload output/status', async (t) => {
  const f = await fixture(t);
  const result = await run(
    [
      process.execPath,
      '-e',
      `console.log("workload"); const fs=require("node:fs");
         const timer=setInterval(()=>{try{if(fs.readFileSync(process.argv[1],"utf8").includes("providerProcessStarted")){clearInterval(timer);process.exit(23)}}catch{}},10);
         setTimeout(()=>process.exit(24),5000).unref()`,
      f.log,
    ],
    f.env,
  );
  assert.equal(result.code, 23);
  assert.equal(result.stdout, 'workload\n');
  assert.equal(result.stderr, '');
  const report = await readFile(f.log, 'utf8');
  assert.match(report, /octo%2Fexample%2342%2Fr1\/heartbeat/);
  assert.match(report, /providerProcessStarted/);
  assert.match(report, /Authorization: Bearer private-token/);
  assert.equal(report.split('request =').length, 2);
});
test('failed exec does not publish a start', async (t) => {
  const f = await fixture(t);
  assert.equal((await run([path.join(f.dir, 'missing')], f.env)).code, 127);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});
test('report failure does not change workload result', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.dir, 'curl'), '#!/bin/sh\nexit 22\n', {
    mode: 0o700,
  });
  assert.equal(
    (await run([process.execPath, '-e', 'process.exit(0)'], f.env)).code,
    0,
  );
});
test('forwards termination and retains the conventional signal status', async (t) => {
  const f = await fixture(t);
  const child = spawn(
    process.execPath,
    [
      supervisor,
      process.execPath,
      '-e',
      'console.log("ready");setInterval(()=>{},1000)',
    ],
    { env: f.env },
  );
  await new Promise((resolve) => child.stdout.once('data', resolve));
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGTERM');
  assert.equal(await closed, 143);
});

test('non-executable workload preserves exec status 126 without a start report', async (t) => {
  const f = await fixture(t);
  const executable = path.join(f.dir, 'not-executable');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  assert.equal((await run([executable], f.env)).code, 126);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});
test('stalled reporting cannot turn an immediate workload result into a timeout', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.dir, 'curl'), '#!/bin/sh\nexec sleep 30\n', {
    mode: 0o700,
  });
  const code = await new Promise((resolve) => {
    const child = spawn(
      'timeout',
      [
        '1s',
        process.execPath,
        supervisor,
        process.execPath,
        '-e',
        'process.exit(23)',
      ],
      { env: f.env },
    );
    child.on('close', resolve);
  });
  assert.equal(code, 23);
});
