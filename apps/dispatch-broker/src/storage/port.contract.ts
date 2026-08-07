/**
 * The `StoragePort` contract suite (#645 Phase 5, second bullet: "contract
 * tests" as the deliverable that "makes a later storage choice safe").
 *
 * This file is written against the PORT (./port.ts), never against
 * `InMemoryStoragePort` directly. `./in-memory-port.spec.ts` calls
 * `runStoragePortContractSuite` with a factory that builds an
 * `InMemoryStoragePort`; a future durable backend proves itself by writing
 * its own `<backend>.spec.ts` that imports this same function and calls it
 * with a factory for itself. A implementation that passes this suite is
 * safe to swap in wherever `StoragePort` is the declared type -- that
 * portability is the entire point of having a port at all.
 *
 * Registers `vitest` `test()`s at call time, the same flat-`test` style
 * every other spec in this app uses (no `describe` nesting) -- see e.g.
 * modules/projector.spec.ts. Calling this function from inside a `.spec.ts`
 * module body is what makes vitest pick the tests up; it does nothing on
 * its own if never invoked, by design (a future backend that never adds its
 * own `<backend>.spec.ts` calling this gets no coverage, which is correct --
 * the suite proves nothing about a backend nobody pointed it at).
 *
 * Covers, at minimum, the four scenarios #645 Phase 5 calls out by name:
 *   - read-your-writes;
 *   - a concurrent-modification conflict being detected, not silently
 *     overwritten;
 *   - outbox record-then-resolve;
 *   - crash-between-record-and-resolve leaving a recoverable pending entry.
 * Plus the idempotence and misuse edges the port's own doc comments promise
 * (retried record/resolve calls, a reused operation ID, resolving before
 * recording, overwriting a terminal resolution).
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  type LaunchOutboxResolution,
  type StoragePort,
  type StoredTaskInput,
  TaskWriteConflictError,
} from './port.js';

const TASK = {
  repositoryId: 1307149765,
  repository: 'jlapenna/agent-lcars',
  issue: 645,
};
const OTHER_TASK = {
  repositoryId: 1307149765,
  repository: 'jlapenna/agent-lcars',
  issue: 646,
};

function emptyTaskState(): StoredTaskInput {
  return { signals: [], intents: [] };
}

function oneSignalState(sourceId: string): StoredTaskInput {
  return {
    signals: [
      {
        sourceKind: 'manual',
        sourceId,
        occurredAt: '2026-08-01T00:00:00.000Z',
        authorization: {
          authorized: true,
          actor: 'jlapenna',
          rule: 'manual-maintainer',
        },
      },
    ],
    intents: [],
  };
}

export function runStoragePortContractSuite(
  label: string,
  createPort: () => StoragePort | Promise<StoragePort>,
): void {
  const name = (scenario: string) => `${label}: ${scenario}`;

  // -------------------------------------------------------------------------
  // Task aggregate: read-your-writes, and CAS conflict detection.
  // -------------------------------------------------------------------------

  test(
    name('reading a task that was never written returns undefined'),
    async () => {
      const port = await createPort();
      assert.equal(await port.readTask(TASK), undefined);
    },
  );

  test(
    name('read-your-writes: a write is immediately visible to a read'),
    async () => {
      const port = await createPort();
      const written = await port.writeTask(
        TASK,
        undefined,
        oneSignalState('source-1'),
      );
      assert.equal(written.revision, 1);
      assert.equal(written.signals.length, 1);
      assert.equal(written.signals[0].sourceId, 'source-1');

      const read = await port.readTask(TASK);
      assert.ok(read);
      assert.deepEqual(read, written);
    },
  );

  test(
    name(
      'a second write with the prior revision is applied and bumps the revision',
    ),
    async () => {
      const port = await createPort();
      const first = await port.writeTask(
        TASK,
        undefined,
        oneSignalState('source-1'),
      );
      const second = await port.writeTask(
        TASK,
        first.revision,
        oneSignalState('source-2'),
      );
      assert.equal(second.revision, 2);
      assert.equal(second.signals[0].sourceId, 'source-2');

      const read = await port.readTask(TASK);
      assert.deepEqual(read, second);
    },
  );

  test(
    name(
      'writing with a stale expected revision throws a conflict instead of overwriting',
    ),
    async () => {
      const port = await createPort();
      const created = await port.writeTask(
        TASK,
        undefined,
        oneSignalState('source-1'),
      );

      // Two readers both start from revision 1; writer A commits...
      await port.writeTask(TASK, created.revision, oneSignalState('source-2'));

      // ...writer B, still holding the stale revision it originally read,
      // must be told about the conflict rather than clobbering A's write.
      await assert.rejects(
        () =>
          port.writeTask(TASK, created.revision, oneSignalState('source-3')),
        TaskWriteConflictError,
      );

      // A's write survives untouched -- the defining property of a real
      // conflict signal instead of last-write-wins.
      const read = await port.readTask(TASK);
      assert.equal(read?.signals[0].sourceId, 'source-2');
      assert.equal(read?.revision, 2);
    },
  );

  test(
    name('writing a brand-new task with a defined expected revision conflicts'),
    async () => {
      const port = await createPort();
      await assert.rejects(
        () => port.writeTask(TASK, 1, oneSignalState('source-1')),
        TaskWriteConflictError,
      );
      assert.equal(await port.readTask(TASK), undefined);
    },
  );

  test(
    name('writing an existing task with expectedRevision undefined conflicts'),
    async () => {
      const port = await createPort();
      await port.writeTask(TASK, undefined, emptyTaskState());
      await assert.rejects(
        () => port.writeTask(TASK, undefined, oneSignalState('source-1')),
        TaskWriteConflictError,
      );
    },
  );

  test(name('two tasks are stored and read independently'), async () => {
    const port = await createPort();
    await port.writeTask(TASK, undefined, oneSignalState('mine'));
    await port.writeTask(OTHER_TASK, undefined, oneSignalState('theirs'));

    const mine = await port.readTask(TASK);
    const theirs = await port.readTask(OTHER_TASK);
    assert.equal(mine?.signals[0].sourceId, 'mine');
    assert.equal(theirs?.signals[0].sourceId, 'theirs');
  });

  test(
    name(
      'a value returned by readTask can be mutated by the caller without corrupting stored state',
    ),
    async () => {
      const port = await createPort();
      await port.writeTask(TASK, undefined, oneSignalState('source-1'));
      const read = await port.readTask(TASK);
      assert.ok(read);
      read.signals.push({
        sourceKind: 'tampered',
        sourceId: 'should-not-persist',
        occurredAt: '2026-08-01T00:00:00.000Z',
        authorization: { authorized: false },
      });

      const readAgain = await port.readTask(TASK);
      assert.equal(readAgain?.signals.length, 1);
    },
  );

  // -------------------------------------------------------------------------
  // Launch outbox: record-then-resolve, and crash-between-record-and-resolve.
  // -------------------------------------------------------------------------

  test(name('recording a launch intent creates a pending entry'), async () => {
    const port = await createPort();
    const operation = await port.recordLaunchIntent({
      operationId: 'g1:intent-1',
      task: TASK,
      attemptId: 'g1:intent-1',
    });
    assert.equal(operation.status, 'pending');
    assert.equal(operation.resolvedAt, undefined);

    const read = await port.readLaunchOperation('g1:intent-1');
    assert.deepEqual(read, operation);
  });

  test(
    name('record-then-resolve: a launched resolution is durable and terminal'),
    async () => {
      const port = await createPort();
      await port.recordLaunchIntent({
        operationId: 'g1:intent-1',
        task: TASK,
        attemptId: 'g1:intent-1',
      });
      const resolution: LaunchOutboxResolution = {
        status: 'launched',
        binding: {
          runId: 42,
          runUrl:
            'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/42',
          htmlUrl: 'https://github.com/jlapenna/agent-lcars/actions/runs/42',
        },
      };
      const resolved = await port.resolveLaunchOutcome(
        'g1:intent-1',
        resolution,
      );
      assert.equal(resolved.status, 'launched');
      assert.deepEqual(resolved.resolution, resolution);
      assert.ok(resolved.resolvedAt);

      const read = await port.readLaunchOperation('g1:intent-1');
      assert.deepEqual(read, resolved);
    },
  );

  test(
    name(
      'crash-between-record-and-resolve: an entry that was only ever recorded stays pending and discoverable',
    ),
    async () => {
      const port = await createPort();
      // Simulates the exact failure this outbox exists to make recoverable:
      // the process recorded intent to launch and then never got to call
      // resolveLaunchOutcome at all -- e.g. it crashed between making the
      // dispatch call and handling its response. Nothing here calls resolve.
      await port.recordLaunchIntent({
        operationId: 'g1:intent-1',
        task: TASK,
        attemptId: 'g1:intent-1',
      });

      const pending = await port.listPendingLaunchOperations();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].operationId, 'g1:intent-1');
      assert.equal(pending[0].status, 'pending');

      // A recovery pass can still resolve it later -- the whole point of it
      // having stayed a recoverable, addressable record rather than
      // disappearing or being ambiguous about whether it was ever attempted.
      const resolved = await port.resolveLaunchOutcome('g1:intent-1', {
        status: 'unknown',
        reason:
          'no completion callback observed before reconciliation swept it',
      });
      assert.equal(resolved.status, 'unknown');
      assert.equal((await port.listPendingLaunchOperations()).length, 0);
    },
  );

  test(
    name('listPendingLaunchOperations only returns entries still pending'),
    async () => {
      const port = await createPort();
      await port.recordLaunchIntent({
        operationId: 'pending-op',
        task: TASK,
        attemptId: 'pending-op',
      });
      await port.recordLaunchIntent({
        operationId: 'resolved-op',
        task: TASK,
        attemptId: 'resolved-op',
      });
      await port.resolveLaunchOutcome('resolved-op', {
        status: 'rejected',
        reason: 'HTTP 422',
      });

      const pending = await port.listPendingLaunchOperations();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].operationId, 'pending-op');
    },
  );

  test(
    name(
      'recording the same operation ID twice with the same attempt is idempotent',
    ),
    async () => {
      const port = await createPort();
      const first = await port.recordLaunchIntent({
        operationId: 'g1:intent-1',
        task: TASK,
        attemptId: 'g1:intent-1',
      });
      const second = await port.recordLaunchIntent({
        operationId: 'g1:intent-1',
        task: TASK,
        attemptId: 'g1:intent-1',
      });
      assert.deepEqual(second, first);
      assert.equal((await port.listPendingLaunchOperations()).length, 1);
    },
  );

  test(
    name('recording the same operation ID for a different attempt throws'),
    async () => {
      const port = await createPort();
      await port.recordLaunchIntent({
        operationId: 'reused-id',
        task: TASK,
        attemptId: 'g1:intent-1',
      });
      await assert.rejects(() =>
        port.recordLaunchIntent({
          operationId: 'reused-id',
          task: TASK,
          attemptId: 'g2:intent-2',
        }),
      );
    },
  );

  test(
    name('resolving an operation that was never recorded throws'),
    async () => {
      const port = await createPort();
      await assert.rejects(() =>
        port.resolveLaunchOutcome('never-recorded', {
          status: 'rejected',
          reason: 'HTTP 422',
        }),
      );
    },
  );

  test(
    name(
      'resolving an already-resolved operation with the same resolution is idempotent',
    ),
    async () => {
      const port = await createPort();
      await port.recordLaunchIntent({
        operationId: 'g1:intent-1',
        task: TASK,
        attemptId: 'g1:intent-1',
      });
      const resolution: LaunchOutboxResolution = {
        status: 'rejected',
        reason: 'HTTP 422',
      };
      const first = await port.resolveLaunchOutcome('g1:intent-1', resolution);
      const second = await port.resolveLaunchOutcome('g1:intent-1', resolution);
      assert.deepEqual(second, first);
    },
  );

  test(
    name(
      'resolving an already-resolved operation with a different resolution throws',
    ),
    async () => {
      const port = await createPort();
      await port.recordLaunchIntent({
        operationId: 'g1:intent-1',
        task: TASK,
        attemptId: 'g1:intent-1',
      });
      await port.resolveLaunchOutcome('g1:intent-1', {
        status: 'rejected',
        reason: 'HTTP 422',
      });
      await assert.rejects(() =>
        port.resolveLaunchOutcome('g1:intent-1', {
          status: 'launched',
          binding: { runId: 1, runUrl: 'https://x', htmlUrl: 'https://x' },
        }),
      );
    },
  );

  test(
    name(
      'a value returned by readLaunchOperation can be mutated without corrupting stored state',
    ),
    async () => {
      const port = await createPort();
      await port.recordLaunchIntent({
        operationId: 'g1:intent-1',
        task: TASK,
        attemptId: 'g1:intent-1',
      });
      const read = await port.readLaunchOperation('g1:intent-1');
      assert.ok(read);
      (read as { status: string }).status = 'launched';

      const readAgain = await port.readLaunchOperation('g1:intent-1');
      assert.equal(readAgain?.status, 'pending');
    },
  );
}
