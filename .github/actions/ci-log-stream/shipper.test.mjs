/* eslint-disable vitest/no-import-node-test -- exercise the dependency-free shipper with the same Node runtime used by the action. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { PageLogShipper } from './shipper.mjs';

const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ci-log-shipper-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function lokiServer(statuses = [204], responseDelayMs = 0) {
  const requests = [];
  let requestIndex = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      const status = statuses[Math.min(requestIndex, statuses.length - 1)];
      requestIndex += 1;
      setTimeout(
        () => response.writeHead(status, { connection: 'close' }).end(),
        responseDelayMs,
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return {
    requests,
    endpoint: `http://127.0.0.1:${address.port}/loki/api/v1/push`,
  };
}

function makeShipper(directory, endpoint, overrides = {}) {
  let now = 1_800_000_000_000;
  return new PageLogShipper({
    pageDirectory: directory,
    endpoint,
    labels: {
      job: 'gha-ci',
      repo: 'jlapenna/agent-lcars',
      workflow: 'CI',
      runner_host: 'laforge',
    },
    metadata: {
      run_id: '1234',
      run_attempt: '2',
      job_name: 'verify-full',
      sha: 'abc123',
    },
    diagnosticPath: path.join(directory, '.shipper-diagnostic'),
    now: () => now++,
    ...overrides,
  });
}

test('backfills existing page logs with low-cardinality labels and structured metadata', async () => {
  const directory = await temporaryDirectory();
  const loki = await lokiServer();
  await writeFile(
    path.join(
      directory,
      '11111111-1111-1111-1111-111111111111_22222222-2222-2222-2222-222222222222_0.log',
    ),
    '2026-08-30T04:00:00.0000000Z ##[group]Run pnpm verify\n' +
      '2026-08-30T04:00:01.0000000Z ✓ contracts passed\n',
  );

  const shipper = makeShipper(directory, loki.endpoint);
  await shipper.tick();

  assert.equal(loki.requests.length, 1);
  const stream = loki.requests[0].streams[0];
  assert.deepEqual(stream.stream, {
    job: 'gha-ci',
    repo: 'jlapenna/agent-lcars',
    workflow: 'CI',
    runner_host: 'laforge',
  });
  assert.equal('run_id' in stream.stream, false);
  assert.deepEqual(
    stream.values.map((value) => value[1]),
    [
      '2026-08-30T04:00:00.0000000Z ##[group]Run pnpm verify',
      '2026-08-30T04:00:01.0000000Z ✓ contracts passed',
    ],
  );
  assert.deepEqual(stream.values[1][2], {
    run_id: '1234',
    run_attempt: '2',
    job_name: 'verify-full',
    sha: 'abc123',
    step_name: 'pnpm verify',
  });
});

test('rediscovers synthetic rotated pages and retains the step name', async () => {
  const directory = await temporaryDirectory();
  const loki = await lokiServer();
  const prefix =
    '11111111-1111-1111-1111-111111111111_22222222-2222-2222-2222-222222222222';
  await writeFile(
    path.join(directory, `${prefix}_0.log`),
    '2026-08-30T04:00:00Z ##[group]Run generate 9MB fixture\n' +
      '2026-08-30T04:00:01Z page zero\n',
  );
  const shipper = makeShipper(directory, loki.endpoint);
  await shipper.tick();

  await writeFile(
    path.join(directory, `${prefix}_1.log`),
    '2026-08-30T04:00:02Z page one after rotation\n',
  );
  await shipper.tick();

  assert.equal(loki.requests.length, 2);
  assert.equal(
    loki.requests[1].streams[0].values[0][1],
    '2026-08-30T04:00:02Z page one after rotation',
  );
  assert.equal(
    loki.requests[1].streams[0].values[0][2].step_name,
    'generate 9MB fixture',
  );
});

test('reads double-digit page rotations in numeric order', async () => {
  const directory = await temporaryDirectory();
  const loki = await lokiServer();
  await writeFile(path.join(directory, 'job_all_10.log'), 'page ten\n');
  await writeFile(path.join(directory, 'job_all_2.log'), 'page two\n');
  await writeFile(path.join(directory, 'job_all_1.log'), 'page one\n');

  const shipper = makeShipper(directory, loki.endpoint);
  await shipper.tick();

  assert.deepEqual(
    loki.requests.flatMap((request) =>
      request.streams[0].values.map((value) => value[1]),
    ),
    ['page one', 'page two', 'page ten'],
  );
});

test('selects the cumulative job pages instead of duplicating per-step pages', async () => {
  const directory = await temporaryDirectory();
  const loki = await lokiServer();
  const sharedLine = '2026-08-30T04:00:01Z checkout output';
  await writeFile(
    path.join(directory, 'job_all_0.log'),
    `2026-08-30T04:00:00Z setup output\n${sharedLine}\n`,
  );
  await writeFile(
    path.join(directory, 'job_checkout_0.log'),
    `${sharedLine}\n`,
  );

  const shipper = makeShipper(directory, loki.endpoint);
  await shipper.tick();

  assert.deepEqual(
    loki.requests.flatMap((request) =>
      request.streams[0].values.map((value) => value[1]),
    ),
    ['2026-08-30T04:00:00Z setup output', sharedLine],
  );
});

test('ships every line across synthetic page rotation beyond 8 MiB', async () => {
  const directory = await temporaryDirectory();
  const loki = await lokiServer();
  const prefix = 'job_step';
  const lines = Array.from(
    { length: 9000 },
    (_, index) =>
      `2026-08-30T04:00:00Z line-${String(index).padStart(4, '0')} ${'x'.repeat(1000)}`,
  );
  const firstPageLines = 8100;
  const firstPage = `${lines.slice(0, firstPageLines).join('\n')}\n`;
  const secondPage = `${lines.slice(firstPageLines).join('\n')}\n`;
  assert.ok(
    Buffer.byteLength(firstPage) + Buffer.byteLength(secondPage) >
      8 * 1024 * 1024,
  );
  await writeFile(path.join(directory, `${prefix}_0.log`), firstPage);
  await writeFile(path.join(directory, `${prefix}_1.log`), secondPage);

  const shipper = makeShipper(directory, loki.endpoint);
  for (let index = 0; index < 50; index += 1) await shipper.tick();

  const shippedLines = loki.requests.flatMap((request) =>
    request.streams[0].values.map((value) => value[1]),
  );
  assert.equal(shipper.droppedLines, 0);
  assert.deepEqual(shippedLines, lines);
});

test('keeps failed pushes bounded and never throws on Loki backpressure', async () => {
  const directory = await temporaryDirectory();
  const loki = await lokiServer([429]);
  await writeFile(
    path.join(directory, 'job_step_0.log'),
    Array.from(
      { length: 100 },
      (_, index) => `line ${index} ${'x'.repeat(40)}`,
    ).join('\n') + '\n',
  );

  const shipper = makeShipper(directory, loki.endpoint, {
    config: {
      maxQueueBytes: 700,
      maxBatchBytes: 500,
      initialBackoffMs: 10_000,
    },
  });
  await assert.doesNotReject(() => shipper.tick());
  await assert.doesNotReject(() => shipper.tick());

  assert.equal(loki.requests.length, 1);
  assert.ok(shipper.queueBytes <= 700);
  assert.ok(shipper.queue.length > 0);
  assert.ok(shipper.droppedLines > 0);
});

test('flushes a final unterminated line without changing its bytes', async () => {
  const directory = await temporaryDirectory();
  const loki = await lokiServer();
  await writeFile(
    path.join(directory, 'job_step_0.log'),
    '2026-08-30T04:00:00Z final line without newline',
  );
  const shipper = makeShipper(directory, loki.endpoint);

  await shipper.readAvailable();
  assert.equal(shipper.queue.length, 0);
  shipper.enqueuePartialLines();
  await shipper.pushAvailable({ force: true });

  assert.equal(
    loki.requests[0].streams[0].values[0][1],
    '2026-08-30T04:00:00Z final line without newline',
  );
});

test('drains more than one read tick before shutdown flushes', async () => {
  const directory = await temporaryDirectory();
  const loki = await lokiServer();
  const lines = Array.from(
    { length: 20 },
    (_, index) => `shutdown line ${index}`,
  );
  await writeFile(path.join(directory, 'job_all_0.log'), lines.join('\n'));
  const shipper = makeShipper(directory, loki.endpoint, {
    config: {
      maxReadBytesPerTick: 32,
      readChunkBytes: 32,
      shutdownBudgetMs: 10_000,
    },
  });

  await shipper.shutdown();

  assert.deepEqual(
    loki.requests.flatMap((request) =>
      request.streams[0].values.map((value) => value[1]),
    ),
    lines,
  );
});

test('drops one oversized partial line without retaining it in memory', async () => {
  const directory = await temporaryDirectory();
  const loki = await lokiServer();
  await writeFile(
    path.join(directory, 'job_all_0.log'),
    `${'x'.repeat(10_000)}\nline after oversized output\n`,
  );
  const shipper = makeShipper(directory, loki.endpoint, {
    config: {
      maxReadBytesPerTick: 64,
      readChunkBytes: 64,
      maxPartialLineBytes: 100,
    },
  });

  for (let index = 0; index < 200; index += 1) await shipper.tick();

  assert.equal(shipper.droppedLines, 1);
  assert.ok(
    [...shipper.files.values()].every((state) => state.carry.length <= 100),
  );
  assert.deepEqual(
    loki.requests.flatMap((request) =>
      request.streams[0].values.map((value) => value[1]),
    ),
    ['line after oversized output'],
  );
});

test('bounds slow successful shutdown pushes by the shutdown deadline', async () => {
  const directory = await temporaryDirectory();
  const loki = await lokiServer([204], 60);
  await writeFile(path.join(directory, 'job_all_0.log'), 'one\ntwo\nthree\n');
  const shipper = makeShipper(directory, loki.endpoint, {
    now: Date.now,
    config: {
      maxBatchLines: 1,
      pushTimeoutMs: 200,
      shutdownBudgetMs: 80,
    },
  });

  const startedAt = Date.now();
  await shipper.shutdown();

  assert.ok(Date.now() - startedAt < 180);
  assert.ok(shipper.queue.length > 0);
  assert.ok(loki.requests.length <= 2);
});
