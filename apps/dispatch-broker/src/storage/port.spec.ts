/**
 * Unit tests for `updateTask` (port.ts) -- the retry-on-conflict read-
 * modify-write helper built on top of the port's CAS primitive
 * (`readTask`/`writeTask`). Deliberately separate from ./port.contract.ts:
 * `updateTask` is not part of `StoragePort` and every backend gets it for
 * free once its `readTask`/`writeTask` satisfy the contract suite, so it
 * only needs testing once here rather than once per backend.
 *
 * Uses `InMemoryStoragePort` as a concrete port to exercise `updateTask`
 * against -- a stand-in for any conforming implementation, not the subject
 * under test.
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { InMemoryStoragePort } from './in-memory-port.js';
import { TaskWriteConflictError, updateTask } from './port.js';

const TASK = {
  repositoryId: 1307149765,
  repository: 'jlapenna/agent-lcars',
  issue: 645,
};

test('updateTask creates a task when none exists, passing undefined to transform', async () => {
  const port = new InMemoryStoragePort();
  let sawCurrent: unknown = 'not called';
  const result = await updateTask(port, TASK, (current) => {
    sawCurrent = current;
    return { signals: [], intents: [] };
  });
  assert.equal(sawCurrent, undefined);
  assert.equal(result.revision, 1);
});

test('updateTask reads the latest state and writes it forward by one revision', async () => {
  const port = new InMemoryStoragePort();
  await port.writeTask(TASK, undefined, {
    signals: [
      {
        sourceKind: 'manual',
        sourceId: 'source-1',
        occurredAt: '2026-08-01T00:00:00.000Z',
        authorization: { authorized: true },
      },
    ],
    intents: [],
  });

  const result = await updateTask(port, TASK, (current) => ({
    signals: [
      ...(current?.signals ?? []),
      {
        sourceKind: 'manual',
        sourceId: 'source-2',
        occurredAt: '2026-08-01T00:00:01.000Z',
        authorization: { authorized: true },
      },
    ],
    intents: [],
  }));

  assert.equal(result.revision, 2);
  assert.equal(result.signals.length, 2);
});

test('updateTask retries the whole read-transform-write cycle when a concurrent writer wins the race', async () => {
  const port = new InMemoryStoragePort();
  await port.writeTask(TASK, undefined, { signals: [], intents: [] });

  let attempts = 0;
  const result = await updateTask(port, TASK, (current) => {
    attempts += 1;
    if (attempts === 1) {
      // Simulate a second writer landing between this transform's read and
      // updateTask's own write -- the exact race writeTask's CAS precondition
      // exists to catch. Racing directly on the port (bypassing updateTask)
      // models "some other caller" rather than this same retry loop.
      void port.writeTask(TASK, current?.revision, {
        signals: [
          {
            sourceKind: 'racing-writer',
            sourceId: 'concurrent-source',
            occurredAt: '2026-08-01T00:00:00.000Z',
            authorization: { authorized: true },
          },
        ],
        intents: [],
      });
    }
    return {
      signals: [
        ...(current?.signals ?? []),
        {
          sourceKind: 'manual',
          sourceId: `attempt-${attempts}`,
          occurredAt: '2026-08-01T00:00:00.000Z',
          authorization: { authorized: true },
        },
      ],
      intents: [],
    };
  });

  // Two calls: the first raced and conflicted, the second saw the racing
  // writer's state and succeeded from it.
  assert.equal(attempts, 2);
  assert.equal(result.revision, 3);
  const sourceIds = result.signals.map((signal) => signal.sourceId);
  assert.deepEqual(sourceIds, ['concurrent-source', 'attempt-2']);
});

test('updateTask gives up and throws the conflict once maxAttempts is exhausted', async () => {
  const port = new InMemoryStoragePort();
  await port.writeTask(TASK, undefined, { signals: [], intents: [] });

  await assert.rejects(
    () =>
      updateTask(
        port,
        TASK,
        (current) => {
          // Always race, on every attempt -- the transform never gets to
          // write against the revision it just read.
          void port.writeTask(TASK, current?.revision, {
            signals: [],
            intents: [],
          });
          return { signals: [], intents: [] };
        },
        { maxAttempts: 3 },
      ),
    TaskWriteConflictError,
  );
});
