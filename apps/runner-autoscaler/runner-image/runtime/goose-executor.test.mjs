/* eslint-disable vitest/no-import-node-test -- runner-image shell suite and Docker image use node --test without Vitest. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  classifyGooseProviderFailure,
  gooseExecutor,
  parseGooseResult,
  readGooseResultFile,
  settleGooseFailure,
  subprocess,
} from './goose-executor.mjs';

test('only a completed final assistant result becomes an artifact', () => {
  const envelope = {
    metadata: { status: 'completed' },
    messages: [
      { role: 'tool', content: [{ type: 'text', text: '{"complete":true}' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '{"complete":false}' }],
      },
    ],
  };
  assert.deepEqual(parseGooseResult(JSON.stringify(envelope)), {
    complete: false,
  });
  envelope.metadata.status = 'failed';
  assert.throws(() => parseGooseResult(JSON.stringify(envelope)), /completed/);
  envelope.metadata.status = 'completed';
  envelope.messages.pop();
  assert.throws(
    () => parseGooseResult(JSON.stringify(envelope)),
    /final assistant/,
  );
});
test('subprocess preserves resource causes without exposing stderr secrets', async () => {
  await assert.rejects(
    subprocess(
      process.execPath,
      [
        '-e',
        'console.error("private-token No space left on device");process.exit(1)',
      ],
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        environment: {},
      },
    ),
    (error) =>
      error.message.includes('No space left on device') &&
      !error.message.includes('private-token'),
  );
});
test('subprocess names an unreachable provider without its message', async () => {
  await assert.rejects(
    subprocess(
      process.execPath,
      [
        '-e',
        'console.error("Error: Network error: Could not connect to private-host:443");process.exit(1)',
      ],
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        environment: {},
      },
    ),
    (error) =>
      error.message === 'Goose exited 1: Network error; Could not connect',
  );
});
test('output overflow fails and cancellation terminates the child', async () => {
  await assert.rejects(
    subprocess(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(17*1024*1024))'],
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        environment: {},
      },
    ),
    /exceeds/,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(
      subprocess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        cwd: '/tmp',
        signal: controller.signal,
        environment: {},
      }),
      /cancelled/,
    );
  } finally {
    clearTimeout(timer);
  }
});
test('adapter validates before invoking and acknowledges actual provider spawn', async () => {
  const directory = await mkdtemp('/tmp/lcars-goose-fixture-');
  try {
    const executable = join(directory, 'goose');
    await writeFile(
      executable,
      `#!${process.execPath}\nif(process.argv[2]!=='recipe')console.log(JSON.stringify({metadata:{status:'completed'},messages:[{role:'assistant',content:[{type:'text',text:'{"complete":true}'}]}]}));\n`,
      { mode: 0o700 },
    );
    let starts = 0;
    const execute = gooseExecutor({
      executable,
      workingDirectory: directory,
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: directory,
        GOOSE_PATH_ROOT: directory,
      },
      assertAllocation: async () => {
        /* This fixture exercises process handling only. */
      },
      onProviderStarted: () => {
        starts++;
      },
    });
    assert.deepEqual(
      await execute({
        run: {
          definition: {
            recipeText: 'fixture',
            job: { inputs: {}, execution: { resources: {} } },
          },
        },
        baseline: null,
        signal: new AbortController().signal,
      }),
      { complete: true },
    );
    assert.equal(starts, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file-parameter recipes pass values larger than one argv string as files', async () => {
  const directory = await mkdtemp('/tmp/lcars-goose-files-');
  try {
    const executable = join(directory, 'goose');
    // The fixture echoes what Goose would read: each --params value is a path
    // whose contents become the parameter, as for a Goose `file` parameter.
    await writeFile(
      executable,
      `#!${process.execPath}
const { readFileSync } = require('node:fs');
if (process.argv[2] === 'recipe') process.exit(0);
const recipe = readFileSync(process.argv[process.argv.indexOf('--recipe') + 1], 'utf8');
const values = {};
for (let i = 0; i < process.argv.length; i++)
  if (process.argv[i] === '--params') {
    const [key, path] = process.argv[i + 1].split(/=(.*)/su);
    values[key] = readFileSync(path, 'utf8');
  }
const text = JSON.stringify({ complete: true, recipe, values });
console.log(JSON.stringify({ metadata: { status: 'completed' }, messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] }));
`,
      { mode: 0o700 },
    );
    const execute = gooseExecutor({
      executable,
      workingDirectory: directory,
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: directory,
        GOOSE_PATH_ROOT: directory,
      },
      assertAllocation: async () => {
        /* Parameter transport fixture. */
      },
    });
    // Each value alone exceeds Linux's 128 KiB MAX_ARG_STRLEN.
    const baseline = { findings: 'b'.repeat(512 * 1024) };
    const target = 't'.repeat(200 * 1024);
    const result = await execute({
      run: {
        definition: {
          recipeText: 'original',
          job: { inputs: { mode: 'report' }, execution: { resources: {} } },
        },
        fileRecipeText: 'rewritten',
      },
      baseline,
      parameters: { target },
      signal: new AbortController().signal,
    });
    assert.equal(result.recipe, 'rewritten');
    assert.deepEqual(result.values, {
      target,
      mode: 'report',
      baseline: JSON.stringify(baseline),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('argv fallback refuses a value Linux cannot pass, naming the parameter', async () => {
  const directory = await mkdtemp('/tmp/lcars-goose-argv-');
  try {
    const executable = join(directory, 'goose');
    await writeFile(executable, `#!${process.execPath}\nprocess.exit(0);\n`, {
      mode: 0o700,
    });
    const execute = gooseExecutor({
      executable,
      workingDirectory: directory,
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: directory,
        GOOSE_PATH_ROOT: directory,
      },
      assertAllocation: async () => {
        /* Argument guard fixture. */
      },
    });
    await assert.rejects(
      execute({
        run: {
          definition: {
            recipeText: 'fixture',
            job: { inputs: {}, execution: { resources: {} } },
          },
        },
        baseline: { data: 'b'.repeat(200 * 1024) },
        signal: new AbortController().signal,
      }),
      /Recipe parameter baseline exceeds the 128 KiB argument limit/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('gooseExecutor tags provider-limit and provider-capacity failures on goose run only', async () => {
  const directory = await mkdtemp('/tmp/lcars-goose-limit-');
  try {
    const executable = join(directory, 'goose');
    const run = {
      definition: {
        recipeText: 'fixture',
        job: { inputs: {}, execution: { resources: {} } },
      },
    };
    const execute = gooseExecutor({
      executable,
      workingDirectory: directory,
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: directory,
        GOOSE_PATH_ROOT: directory,
      },
      assertAllocation: async () => {
        /* Process classification fixture. */
      },
    });
    for (const [stderrLine, expected] of [
      [
        'Error: Rate limit exceeded after retries (secret-key)',
        'provider-limit',
      ],
      ['AGY_ERROR: RESOURCE_EXHAUSTED (code 429)', 'provider-limit'],
      [
        'HTTP 400 service_spend_limit_reached (org_spend_cap_reached)',
        'provider-limit',
      ],
      ['Error: model is at capacity right now', 'provider-capacity'],
      ['Error: Server error 500 internal', undefined],
    ]) {
      await writeFile(
        executable,
        `#!${process.execPath}
if (process.argv[2] !== 'recipe') {
  console.error(${JSON.stringify(stderrLine)});
  process.exit(1);
}`,
        { mode: 0o700 },
      );
      await assert.rejects(
        execute({ run, baseline: null, signal: new AbortController().signal }),
        (error) => {
          assert.equal(error.providerOutcome, expected);
          assert.ok(!error.message.includes('secret-key'));
          return true;
        },
      );
    }
    // Recipe validation failures before `goose run` never masquerade as provider stops.
    await writeFile(
      executable,
      `#!${process.execPath}
if (process.argv[2] === 'recipe') {
  console.error('Rate limit exceeded');
  process.exit(1);
}`,
      { mode: 0o700 },
    );
    await assert.rejects(
      execute({ run, baseline: null, signal: new AbortController().signal }),
      (error) => {
        assert.equal(error.providerOutcome, undefined);
        return true;
      },
    );
    assert.equal(
      classifyGooseProviderFailure(new Error('ordinary error')),
      undefined,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('settleGooseFailure logs cause, persists Codex auth before completing, and falls back on abort or settlement error', async () => {
  const events = [];
  const logs = [];
  const limitError = Object.assign(
    new Error('Goose exited 1: Rate limit exceeded'),
    { providerOutcome: 'provider-limit' },
  );
  const codexAuth = {
    persistenceAttempted: false,
    async persist() {
      this.persistenceAttempted = true;
      events.push('persist');
    },
  };
  assert.deepEqual(
    await settleGooseFailure(limitError, {
      aborted: false,
      codexAuth,
      complete: async (payload) => {
        events.push(['complete', payload]);
      },
      logError: (message) => logs.push(message),
    }),
    { settled: true, outcome: 'provider-limit' },
  );
  assert.deepEqual(events, [
    'persist',
    [
      'complete',
      {
        outcome: 'provider-limit',
        outcomeReference: null,
        message: 'Goose exited 1: Rate limit exceeded',
      },
    ],
  ]);
  assert.deepEqual(logs, ['Goose exited 1: Rate limit exceeded']);

  // Aborted runs never settle as provider-limit.
  const abortedEvents = [];
  assert.deepEqual(
    await settleGooseFailure(limitError, {
      aborted: true,
      codexAuth: {
        persistenceAttempted: false,
        async persist() {
          abortedEvents.push('persist');
        },
      },
      complete: async () => {
        abortedEvents.push('complete');
      },
      logError: () => {
        /* captured elsewhere */
      },
    }),
    { settled: false },
  );
  assert.deepEqual(abortedEvents, []);

  // Settlement HTTP error logs both cause and settlement failure and returns settled: false.
  const failedLogs = [];
  assert.deepEqual(
    await settleGooseFailure(limitError, {
      aborted: false,
      complete: async () => {
        throw new Error('Work API HTTP 500');
      },
      logError: (message) => failedLogs.push(message),
    }),
    { settled: false },
  );
  assert.deepEqual(failedLogs, [
    'Goose exited 1: Rate limit exceeded',
    'Work API HTTP 500',
  ]);
});

test('declared file preserves failed grades and nested fields instead of model copies', async () => {
  const directory = await mkdtemp('/tmp/lcars-goose-file-');
  try {
    const resultFile = join(directory, 'result.json');
    const expected = {
      report: 'Two legitimate criteria failures',
      complete: false,
      data: { cases: [{ skill: 'labels-dev', score: 0.5, errors: [] }] },
    };
    const executable = join(directory, 'goose');
    const script = (exit = 0, status = 'completed') => `#!${process.execPath}
if(process.argv[2]!=='recipe') {
  require('node:fs').writeFileSync(${JSON.stringify(resultFile)},${JSON.stringify(JSON.stringify(expected))});
  console.log(JSON.stringify({metadata:{status:${JSON.stringify(status)}},messages:[{role:'assistant',content:[{type:'text',text:'A shortened, non-JSON model answer'}]}]}));
  process.exit(${exit});
}`;
    await writeFile(executable, script(), { mode: 0o700 });
    const execute = gooseExecutor({
      executable,
      resultFile,
      workingDirectory: directory,
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: directory,
        GOOSE_PATH_ROOT: directory,
      },
      assertAllocation: async () => {
        /* Process and result transport fixture; allocation has its own boundary. */
      },
    });
    const request = {
      run: {
        definition: {
          recipeText: 'fixture',
          job: { inputs: {}, execution: { resources: {} } },
        },
      },
      baseline: null,
      signal: new AbortController().signal,
    };
    assert.deepEqual(await execute(request), expected);
    await assert.rejects(execute(request), /already exists/);
    await rm(resultFile);
    await writeFile(executable, script(1));
    await assert.rejects(execute(request), /Goose exited 1/);
    await rm(resultFile);
    await writeFile(executable, script(0, 'failed'));
    await assert.rejects(execute(request), /completed conversation/);
    await rm(resultFile);
    await writeFile(
      executable,
      `#!${process.execPath}
if(process.argv[2]!=='recipe')console.log(JSON.stringify({metadata:{status:'completed'},messages:[]}));`,
    );
    await assert.rejects(execute(request), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('declared result rejects unsafe paths, links, nonfiles, invalid JSON and oversized output', async () => {
  const directory = await mkdtemp('/tmp/lcars-goose-boundary-');
  try {
    const path = join(directory, 'result.json');
    for (const invalid of [
      '/run/secrets/result.json',
      '/tmp/../result.json',
      '/tmp//result.json',
      '/tmp/./result.json',
    ])
      await assert.rejects(readGooseResultFile(invalid), /Invalid declared/);
    await writeFile(path, 'not JSON');
    await assert.rejects(readGooseResultFile(path), SyntaxError);
    // A result above the former 256 KiB cap is read in full.
    const large = { data: 'r'.repeat(1024 * 1024) };
    await writeFile(path, JSON.stringify(large));
    assert.deepEqual(await readGooseResultFile(path), large);
    await writeFile(path, 'x'.repeat(4 * 1024 * 1024 + 1));
    await assert.rejects(readGooseResultFile(path), /4 MiB/);
    await rm(path);
    await mkdir(path);
    await assert.rejects(readGooseResultFile(path), /regular JSON file/);
    await rm(path, { recursive: true });
    await writeFile(join(directory, 'original.json'), '{}');
    await symlink(join(directory, 'original.json'), path);
    await assert.rejects(readGooseResultFile(path), /symbolic links/);
    await symlink(directory, join(directory, 'alias'));
    await assert.rejects(
      readGooseResultFile(join(directory, 'alias', 'original.json')),
      /symbolic links/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
