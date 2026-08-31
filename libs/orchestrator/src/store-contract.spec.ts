import { Firestore } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';

import { FirestoreScheduleStore } from './firestore-schedule-store';
import { FirestoreStore } from './firestore-store';
import { MemoryScheduleStore } from './memory-schedule-store';
import { MemoryStore } from './memory-store';
import { outboxEntrySchema, taskSchema } from './model';
<<<<<<< HEAD
import { Orchestrator } from './orchestrator';
import { encodePersistedMigrationCursor } from './persisted-record-migration';
import {
  runOrchestratorStoreContract,
  runScheduleStoreContract,
} from './store-contract';

runOrchestratorStoreContract('MemoryStore', () => new MemoryStore());
runScheduleStoreContract(
  'MemoryScheduleStore',
  () => new MemoryScheduleStore(),
);

describe('taskSchema', () => {
  it('reads a legacy task document that predates consecutiveLost fine', () => {
    // No `apply()`/store round trip needed here -- this is the schema
    // itself proving it accepts documents written before `consecutiveLost`
    // existed, exactly as `FirestoreStore.readTask`
    // would parse one off a real, older document.
    const legacyDoc: unknown = {
      task: { repo: 'octo/example', issue: 7 },
      activeRunId: 'octo/example#7/r1',
      runCount: 1,
      updatedAt: '2026-08-15T12:00:00.000Z',
    };
    const parsed = taskSchema.parse(legacyDoc);
    expect(parsed.consecutiveLost).toBeUndefined();
  });
});

describe('outboxEntrySchema', () => {
  it.each(['pending', 'done'] as const)(
    'reads a legacy %s entry without lease fields',
    (state) => {
      expect(
        outboxEntrySchema.parse({
          entryId: 'dispatch/octo/example#7/r1',
          kind: 'dispatch-run',
          task: { repo: 'octo/example', issue: 7 },
          runId: 'octo/example#7/r1',
          state,
          attempts: 0,
          createdAt: '2026-08-15T12:00:00.000Z',
          updatedAt: '2026-08-15T12:00:00.000Z',
        }),
      ).toMatchObject({ state });
    },
  );
});

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

// The `test-firestore` Nx target sets REQUIRE_FIRESTORE_EMULATOR=1
// alongside FIRESTORE_EMULATOR_HOST: that target exists specifically to
// run this contract against a real emulator, so a misconfigured
// environment there (emulator host unset, or a startup race that drops it)
// must fail loudly rather than have `describe.skipIf` below quietly pass
// the whole suite vacuously.
if (
  process.env['REQUIRE_FIRESTORE_EMULATOR'] === '1' &&
  emulatorHost === undefined
) {
  throw new Error(
    'REQUIRE_FIRESTORE_EMULATOR=1 but FIRESTORE_EMULATOR_HOST is unset',
  );
}

// Only runs against a real Firestore emulator, opted into via
// FIRESTORE_EMULATOR_HOST; otherwise this whole block is skipped so the
// suite still passes hermetically (e.g. in CI without an emulator wired up).
describe.skipIf(emulatorHost === undefined)('FirestoreStore (emulator)', () => {
  let prefixCounter = 0;

  it('reads only candidates for the requested idempotency key', async () => {
    prefixCounter += 1;
    const collectionPrefix = `orchestrator-test-${Date.now()}-${prefixCounter}-`;
    const firestore = new Firestore({
      projectId: 'demo-orchestrator',
      databaseId: '(default)',
      host: emulatorHost ?? 'localhost:8080',
      ssl: false,
    });
    const taskId = { repo: 'octo/example', issue: 901 } as const;

    // This malformed document deliberately shares the task anchor. An
    // unbounded task-history scan attempts to parse it and rejects the new
    // request; the exact requestId query must never read it.
    await firestore.collection(`${collectionPrefix}runs`).doc('unrelated').set({
      task: taskId,
      requestId: 'some-other-request',
    });

    const orchestrator = new Orchestrator(
      new FirestoreStore({
        projectId: 'demo-orchestrator',
        databaseId: '(default)',
        collectionPrefix,
        emulatorHost: emulatorHost ?? 'localhost:8080',
      }),
      { now: () => '2026-08-31T12:00:00.000Z' },
    );
    await expect(
      orchestrator.request({
        taskId,
        requestId: 'requested-key',
        pipeline: 'codex',
      }),
    ).resolves.toMatchObject({
      run: { requestId: 'requested-key', requestSource: 'caller' },
    });

    await firestore.terminate();
  });

  runOrchestratorStoreContract('FirestoreStore', () => {
    prefixCounter += 1;
    // A fresh prefix per store instance (i.e. per test, since each test's
    // fixture() calls makeStore() anew) so concurrent/re-run test suites
    // never collide on the same documents in the shared emulator.
    return new FirestoreStore({
      projectId: 'demo-orchestrator',
      databaseId: '(default)',
      collectionPrefix: `orchestrator-test-${Date.now()}-${prefixCounter}-`,
      emulatorHost: emulatorHost ?? 'localhost:8080',
    });
  });

  runScheduleStoreContract('FirestoreScheduleStore', () => {
    prefixCounter += 1;
    return new FirestoreScheduleStore({
      projectId: 'demo-orchestrator',
      databaseId: '(default)',
      collectionPrefix: `orchestrator-test-${Date.now()}-${prefixCounter}-`,
      emulatorHost: emulatorHost ?? 'localhost:8080',
    });
  });

  describe('persisted-record migration boundary', () => {
    function migrationStore() {
      prefixCounter += 1;
      return new FirestoreStore({
        projectId: 'demo-orchestrator',
        databaseId: '(default)',
        collectionPrefix: `orchestrator-migration-test-${Date.now()}-${prefixCounter}-`,
        emulatorHost: emulatorHost ?? 'localhost:8080',
      });
    }

    async function seedTask(store: FirestoreStore, issue: number) {
      const task = {
        task: { repo: 'octo/example', issue },
        runCount: 0,
        updatedAt: '2026-08-15T12:00:00.000Z',
      };
      await store.apply({
        decision: { task, outbox: [] },
        expectedRevision: undefined,
      });
      return task;
    }

    it('pages a real Firestore collection and rejects invalid, cross-kind, or foreign cursors', async () => {
      const store = migrationStore();
      await Promise.all([
        seedTask(store, 1),
        seedTask(store, 2),
        seedTask(store, 3),
      ]);

      const first = await store.inventoryPersistedRecords({
        kind: 'task',
        limit: 2,
      });
      expect(first.records).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeDefined();
      const second = await store.inventoryPersistedRecords({
        kind: 'task',
        limit: 2,
        cursor: first.nextCursor,
      });
      expect(second.records).toHaveLength(1);
      expect(second.hasMore).toBe(false);
      expect(
        new Set(
          [...first.records, ...second.records].map((record) =>
            JSON.stringify(record.selector),
          ),
        ),
      ).toHaveLength(3);

      await expect(
        store.inventoryPersistedRecords({
          kind: 'task',
          limit: 1,
          cursor: 'not-a-cursor',
        }),
      ).rejects.toThrow('Invalid persisted orchestrator inventory cursor');
      await expect(
        store.inventoryPersistedRecords({
          kind: 'task',
          limit: 1,
          cursor: encodePersistedMigrationCursor('run', 'not-a-task'),
        }),
      ).rejects.toThrow('Invalid persisted orchestrator inventory cursor');
      await expect(
        store.inventoryPersistedRecords({
          kind: 'task',
          limit: 1,
          cursor: encodePersistedMigrationCursor('task', 'not-a-task'),
        }),
      ).rejects.toThrow('Invalid persisted orchestrator inventory cursor');
    });

    it('does no partial write when a reviewed multi-record manifest is stale', async () => {
      const store = migrationStore();
      const firstTask = await seedTask(store, 10);
      const secondTask = await seedTask(store, 11);
      const inventory = await store.inventoryPersistedRecords({
        kind: 'task',
        limit: 10,
      });
      const entries = await Promise.all(
        inventory.records.map(async (record) => {
          if (record.selector?.kind !== 'task') throw new Error('missing task');
          const current = await store.readTask(record.selector.task);
          if (current === undefined) throw new Error('missing stored task');
          return {
            selector: record.selector,
            expectedFingerprint: record.fingerprint,
            replacement: {
              task: {
                ...current.task,
                consecutiveLost: 0,
                work: { reviewed: true },
              },
              revision: current.revision,
            },
          } as const;
        }),
      );
      const preview = await store.previewPersistedMigration(entries);

      const changed = await store.readTask(secondTask.task);
      if (changed === undefined) throw new Error('missing second task');
      await store.apply({
        decision: {
          task: { ...changed.task, updatedAt: '2026-08-16T12:00:00.000Z' },
          outbox: [],
        },
        expectedRevision: changed.revision,
      });

      await expect(
        store.applyPersistedMigration({
          entries,
          reviewedManifestId: preview.manifestId,
        }),
      ).rejects.toThrow('changed after inventory');
      // The first document was valid, but FirestoreStore validates every
      // target before issuing any write, so the stale second entry leaves it
      // untouched too.
      expect((await store.readTask(firstTask.task))?.task.work).toBeUndefined();
    });

    it('applies a reviewed Firestore manifest through the transaction boundary', async () => {
      const store = migrationStore();
      const task = await seedTask(store, 12);
      const page = await store.inventoryPersistedRecords({
        kind: 'task',
        limit: 1,
      });
      const record = page.records[0];
      if (record?.selector?.kind !== 'task') throw new Error('missing task');
      const current = await store.readTask(record.selector.task);
      if (current === undefined) throw new Error('missing stored task');
      const entries = [
        {
          selector: record.selector,
          expectedFingerprint: record.fingerprint,
          replacement: {
            task: {
              ...current.task,
              consecutiveLost: 0,
              work: { reviewed: true },
            },
            revision: current.revision,
          },
        },
      ] as const;
      const preview = await store.previewPersistedMigration(entries);

      await expect(
        store.applyPersistedMigration({
          entries,
          reviewedManifestId: preview.manifestId,
        }),
      ).resolves.toMatchObject({ entries: 1 });
      expect((await store.readTask(task.task))?.task).toMatchObject({
        consecutiveLost: 0,
        work: { reviewed: true },
      });
    });
  });
});
