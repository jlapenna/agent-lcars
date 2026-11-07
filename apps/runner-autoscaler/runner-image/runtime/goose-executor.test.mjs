/* eslint-disable vitest/no-import-node-test -- runner-image shell suite and Docker image use node --test without Vitest. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  gooseExecutor,
  parseGooseResult,
  readGooseResultFile,
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
      ['-e', 'process.stdout.write("x".repeat(2*1024*1024))'],
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
      assertAllocation: async () => {},
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
    await writeFile(path, 'x'.repeat(262145));
    await assert.rejects(readGooseResultFile(path), /256 KiB/);
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
