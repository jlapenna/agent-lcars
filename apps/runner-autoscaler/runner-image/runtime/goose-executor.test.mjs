/* eslint-disable vitest/no-import-node-test -- runner-image shell suite and Docker image use node --test without Vitest. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  gooseExecutor,
  parseGooseResult,
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
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: directory,
        GOOSE_CONFIG_DIR: directory,
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
