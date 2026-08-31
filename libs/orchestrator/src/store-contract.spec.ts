import { Firestore } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';

import { FirestoreScheduleStore } from './firestore-schedule-store';
import { FirestoreStore } from './firestore-store';
import { MemoryScheduleStore } from './memory-schedule-store';
import { MemoryStore } from './memory-store';
import { outboxEntrySchema, taskKey, taskSchema } from './model';
import { Orchestrator } from './orchestrator';
import {
  encodePersistedMigrationAddress,
  encodePersistedMigrationCursor,
  PersistedMigrationCursorError,
  type PersistedMigrationEntry,
} from './persisted-record-migration';
import {
  runOrchestratorStoreContract,
  runScheduleStoreContract,
} from './store-contract';

runOrchestratorStoreContract('MemoryStore', () => new MemoryStore());
runScheduleStoreContract(
  'MemoryScheduleStore',
  () => new MemoryScheduleStore(),
);

const T = '2026-08-15T12:00:00.000Z';

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

  it('removes the open-anchor index field through a real transactional Firestore update', async () => {
    prefixCounter += 1;
    const collectionPrefix = `orchestrator-anchor-projection-${Date.now()}-${prefixCounter}-`;
    const store = new FirestoreStore({
      projectId: 'demo-orchestrator',
      databaseId: '(default)',
      collectionPrefix,
      emulatorHost: emulatorHost ?? 'localhost:8080',
    });
    const firestore = new Firestore({
      projectId: 'demo-orchestrator',
      databaseId: '(default)',
      host: emulatorHost ?? 'localhost:8080',
      ssl: false,
    });
    const anchor = { repo: 'octo/example', issue: 902 } as const;
    const openProjection = {
      anchor,
      kind: 'issue' as const,
      state: 'open' as const,
      title: 'Open anchor',
      body: '',
      url: 'https://github.com/octo/example/issues/902',
      labels: [],
      assigneeLogins: [],
      sourceUpdatedAt: '2026-08-31T12:00:00.000Z',
      observedAt: '2026-08-31T12:00:01.000Z',
    };

    const openGeneration =
      await store.beginGithubAnchorProjectionRefresh(anchor);
    await expect(
      store.applyGithubAnchorProjectionRefresh({
        anchor,
        generation: openGeneration,
        projection: openProjection,
      }),
    ).resolves.toBe(true);
    await expect(store.listOpenGithubAnchorProjections()).resolves.toEqual([
      openProjection,
    ]);

    const closedGeneration =
      await store.beginGithubAnchorProjectionRefresh(anchor);
    const closedProjection = {
      ...openProjection,
      state: 'closed' as const,
      sourceUpdatedAt: '2026-08-31T12:01:00.000Z',
      observedAt: '2026-08-31T12:01:01.000Z',
    };
    await expect(
      store.applyGithubAnchorProjectionRefresh({
        anchor,
        generation: closedGeneration,
        projection: closedProjection,
      }),
    ).resolves.toBe(true);

    // This is deliberately an emulator assertion, not a fake-store sentinel
    // comparison: Firestore itself rejects delete sentinels in a transaction
    // `set` without merge, which was the production backfill failure.
    const snapshot = await firestore
      .collection(`${collectionPrefix}github-anchors`)
      .doc(encodeURIComponent(taskKey(anchor)))
      .get();
    expect(snapshot.data()).toMatchObject({
      projection: closedProjection,
      refreshGeneration: closedGeneration,
    });
    expect(snapshot.data()).not.toHaveProperty('openUpdatedAt');
    await expect(store.listOpenGithubAnchorProjections()).resolves.toEqual([]);
    await firestore.terminate();
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
      ).rejects.toBeInstanceOf(PersistedMigrationCursorError);
      await expect(
        store.inventoryPersistedRecords({
          kind: 'task',
          limit: 1,
          cursor: encodePersistedMigrationCursor('run', 'not-a-task'),
        }),
      ).rejects.toBeInstanceOf(PersistedMigrationCursorError);
      await expect(
        store.inventoryPersistedRecords({
          kind: 'task',
          limit: 1,
          cursor: encodePersistedMigrationCursor('task', 'not-a-task'),
        }),
      ).rejects.toBeInstanceOf(PersistedMigrationCursorError);
      const directPathCursor = Buffer.concat([
        Buffer.from([0x74]),
        Buffer.from('a/b', 'utf8'),
      ]).toString('base64url');
      await expect(
        store.inventoryPersistedRecords({
          kind: 'task',
          limit: 1,
          cursor: directPathCursor,
        }),
      ).rejects.toBeInstanceOf(PersistedMigrationCursorError);
    });

    it('repairs malformed task, run, and outbox records through exact opaque addresses', async () => {
      prefixCounter += 1;
      const collectionPrefix = `orchestrator-migration-address-${Date.now()}-${prefixCounter}-`;
      const store = new FirestoreStore({
        projectId: 'demo-orchestrator',
        databaseId: '(default)',
        collectionPrefix,
        emulatorHost: emulatorHost ?? 'localhost:8080',
      });
      const firestore = new Firestore({
        projectId: 'demo-orchestrator',
        databaseId: '(default)',
        host: emulatorHost ?? 'localhost:8080',
        ssl: false,
      });
      const task = { repo: 'octo/example', issue: 14 } as const;
      const runId = 'octo/example#14/r1';
      const entryId = `dispatch/${runId}`;
      const cases = [
        {
          kind: 'task' as const,
          collection: 'tasks',
          documentId: encodeURIComponent(taskKey(task)),
          malformed: { task: { runCount: 0, updatedAt: T }, revision: 1 },
          replacement: {
            task: {
              task,
              runCount: 0,
              consecutiveLost: 0,
              work: { migrated: true },
              updatedAt: T,
            },
            revision: 1,
          },
        },
        {
          kind: 'run' as const,
          collection: 'runs',
          documentId: encodeURIComponent(runId),
          malformed: {
            task,
            state: 'lost',
            pipeline: 'codex',
            requestId: 'migration-run',
            leaseExpiresAt: T,
            events: [],
            createdAt: T,
            updatedAt: T,
          },
          replacement: {
            runId,
            task,
            state: 'canceled' as const,
            pipeline: 'codex',
            requestId: 'migration-run',
            requestSource: 'caller' as const,
            leaseExpiresAt: T,
            events: [],
            createdAt: T,
            updatedAt: T,
          },
        },
        {
          kind: 'outbox' as const,
          collection: 'outbox',
          documentId: encodeURIComponent(entryId),
          malformed: { kind: 'dispatch-run', state: 'pending', attempts: 0 },
          replacement: {
            entryId,
            kind: 'dispatch-run' as const,
            task,
            runId,
            state: 'done' as const,
            attempts: 0,
            createdAt: T,
            updatedAt: T,
          },
        },
      ];

      for (const candidate of cases) {
        const ref = firestore
          .collection(`${collectionPrefix}${candidate.collection}`)
          .doc(candidate.documentId);
        await ref.set(candidate.malformed);
        const page = await store.inventoryPersistedRecords({
          kind: candidate.kind,
          limit: 1,
        });
        const record = page.records[0];
        expect(record?.selector).toEqual({
          kind: candidate.kind,
          address: encodePersistedMigrationAddress(
            candidate.kind,
            candidate.documentId,
          ),
        });
        if (record?.selector === undefined) throw new Error('missing address');
        const entries = [
          {
            selector: record.selector,
            expectedFingerprint: record.fingerprint,
            replacement: candidate.replacement,
          },
        ] as unknown as PersistedMigrationEntry[];
        const preview = await store.previewPersistedMigration(entries);
        await store.applyPersistedMigration({
          entries,
          reviewedManifestId: preview.manifestId,
        });
        expect((await ref.get()).data()).toEqual(candidate.replacement);
      }

      const staleRunId = 'octo/example#14/r2';
      const staleRef = firestore
        .collection(`${collectionPrefix}runs`)
        .doc(encodeURIComponent(staleRunId));
      await staleRef.set({
        task,
        state: 'lost',
        pipeline: 'codex',
        requestId: 'migration-stale',
        leaseExpiresAt: T,
        events: [],
        createdAt: T,
        updatedAt: T,
      });
      const staleRecord = (
        await store.inventoryPersistedRecords({ kind: 'run', limit: 10 })
      ).records.find((record) => 'address' in (record.selector ?? {}));
      if (staleRecord?.selector === undefined)
        throw new Error('missing stale address');
      const staleEntries = [
        {
          selector: staleRecord.selector,
          expectedFingerprint: staleRecord.fingerprint,
          replacement: {
            runId: staleRunId,
            task,
            state: 'canceled' as const,
            pipeline: 'codex',
            requestId: 'migration-stale',
            requestSource: 'caller' as const,
            leaseExpiresAt: T,
            events: [],
            createdAt: T,
            updatedAt: T,
          },
        },
      ] as unknown as PersistedMigrationEntry[];
      const stalePreview = await store.previewPersistedMigration(staleEntries);
      await staleRef.update({ concurrentChange: true });
      await expect(
        store.applyPersistedMigration({
          entries: staleEntries,
          reviewedManifestId: stalePreview.manifestId,
        }),
      ).rejects.toThrow('changed after inventory');
      expect((await staleRef.get()).data()).not.toHaveProperty('runId');
      await firestore.terminate();
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
          if (
            record.selector?.kind !== 'task' ||
            !('task' in record.selector)
          ) {
            throw new Error('missing task');
          }
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
      if (record?.selector?.kind !== 'task' || !('task' in record.selector)) {
        throw new Error('missing task');
      }
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

    it('deletes only terminal compatibility records through bounded emulator transactions', async () => {
      prefixCounter += 1;
      const collectionPrefix = `orchestrator-migration-delete-${Date.now()}-${prefixCounter}-`;
      const store = new FirestoreStore({
        projectId: 'demo-orchestrator',
        databaseId: '(default)',
        collectionPrefix,
        emulatorHost: emulatorHost ?? 'localhost:8080',
      });
      const firestore = new Firestore({
        projectId: 'demo-orchestrator',
        databaseId: '(default)',
        host: emulatorHost ?? 'localhost:8080',
        ssl: false,
      });
      const task = { repo: 'octo/example', issue: 73 } as const;
      const runId = 'octo/example#73/r1';
      const taskRef = firestore
        .collection(`${collectionPrefix}tasks`)
        .doc(encodeURIComponent(taskKey(task)));
      const runRef = firestore
        .collection(`${collectionPrefix}runs`)
        .doc(encodeURIComponent(runId));
      // These are the census-era shapes: their strict compatibility fields
      // are absent, while the minimum safety facts are coherent.
      await taskRef.set({
        task: { task, runCount: 1, updatedAt: T },
        revision: 1,
      });
      await runRef.set({
        runId,
        task,
        state: 'lost',
        pipeline: 'codex',
        requestId: 'legacy',
        leaseExpiresAt: T,
        events: [],
        createdAt: T,
        updatedAt: T,
      });
      const runRecord = (
        await store.inventoryPersistedRecords({ kind: 'run', limit: 1 })
      ).records[0];
      if (runRecord?.selector === undefined) throw new Error('missing run');
      const runEntry = {
        operation: 'delete' as const,
        selector: runRecord.selector,
        expectedFingerprint: runRecord.fingerprint,
      };
      const runPreview = await store.previewPersistedMigration([runEntry]);
      expect(runPreview.deletions).toEqual([
        { selector: runRecord.selector, status: 'ready', reasons: [] },
      ]);
      await store.applyPersistedMigration({
        entries: [runEntry],
        reviewedManifestId: runPreview.manifestId,
      });
      expect((await runRef.get()).exists).toBe(false);

      const taskRecord = (
        await store.inventoryPersistedRecords({ kind: 'task', limit: 1 })
      ).records[0];
      if (taskRecord?.selector === undefined) throw new Error('missing task');
      const taskEntry = {
        operation: 'delete' as const,
        selector: taskRecord.selector,
        expectedFingerprint: taskRecord.fingerprint,
      };
      const taskPreview = await store.previewPersistedMigration([taskEntry]);
      expect(taskPreview.deletions).toEqual([
        { selector: taskRecord.selector, status: 'ready', reasons: [] },
      ]);
      await store.applyPersistedMigration({
        entries: [taskEntry],
        reviewedManifestId: taskPreview.manifestId,
      });
      expect((await taskRef.get()).exists).toBe(false);

      const invalidParentTask = { repo: 'octo/example', issue: 74 } as const;
      const invalidParentRunId = 'octo/example#74/r1';
      await firestore
        .collection(`${collectionPrefix}tasks`)
        .doc(encodeURIComponent(taskKey(invalidParentTask)))
        .set({
          task: {
            task: invalidParentTask,
            activeRunId: null,
            runCount: 1,
            updatedAt: T,
          },
          revision: 1,
        });
      await firestore
        .collection(`${collectionPrefix}runs`)
        .doc(encodeURIComponent(invalidParentRunId))
        .set({
          runId: invalidParentRunId,
          task: invalidParentTask,
          state: 'finished',
          pipeline: 'codex',
          requestId: 'legacy-invalid-parent',
          leaseExpiresAt: T,
          events: [],
          createdAt: T,
          updatedAt: T,
        });
      const invalidParentRecord = (
        await store.inventoryPersistedRecords({ kind: 'run', limit: 10 })
      ).records.find((record) => record.selector?.kind === 'run');
      if (invalidParentRecord?.selector === undefined) {
        throw new Error('missing invalid-parent run');
      }
      const invalidParentPreview = await store.previewPersistedMigration([
        {
          operation: 'delete',
          selector: invalidParentRecord.selector,
          expectedFingerprint: invalidParentRecord.fingerprint,
        },
      ]);
      expect(invalidParentPreview.deletions[0]).toMatchObject({
        status: 'blocked',
        reasons: expect.arrayContaining(['invalid-parent-task']),
      });

      const mismatchedParentTask = {
        repo: 'octo/example',
        issue: 75,
      } as const;
      const mismatchedEmbeddedTask = {
        repo: 'octo/example',
        issue: 76,
      } as const;
      const mismatchedParentRunId = 'octo/example#75/r1';
      await firestore
        .collection(`${collectionPrefix}tasks`)
        .doc(encodeURIComponent(taskKey(mismatchedParentTask)))
        .set({
          // Keep the exact legacy task shape: no consecutiveLost or work.
          // The collection path identifies #75 but its embedded safety anchor
          // must independently agree before a terminal #75 run is deletable.
          task: {
            task: mismatchedEmbeddedTask,
            runCount: 1,
            updatedAt: T,
          },
          revision: 1,
        });
      await firestore
        .collection(`${collectionPrefix}runs`)
        .doc(encodeURIComponent(mismatchedParentRunId))
        .set({
          // This census-era run intentionally omits requestSource.
          runId: mismatchedParentRunId,
          task: mismatchedParentTask,
          state: 'finished',
          pipeline: 'codex',
          requestId: 'legacy-mismatched-parent',
          leaseExpiresAt: T,
          events: [],
          createdAt: T,
          updatedAt: T,
        });
      const mismatchedParentRecord = (
        await store.inventoryPersistedRecords({ kind: 'run', limit: 10 })
      ).records.find(
        (record) =>
          record.selector?.kind === 'run' &&
          'runId' in record.selector &&
          record.selector.runId === mismatchedParentRunId,
      );
      if (mismatchedParentRecord?.selector === undefined) {
        throw new Error('missing mismatched-parent run');
      }
      const mismatchedParentPreview = await store.previewPersistedMigration([
        {
          operation: 'delete',
          selector: mismatchedParentRecord.selector,
          expectedFingerprint: mismatchedParentRecord.fingerprint,
        },
      ]);
      expect(mismatchedParentPreview.deletions[0]).toMatchObject({
        status: 'blocked',
        reasons: expect.arrayContaining(['invalid-parent-task']),
      });
      await firestore.terminate();
    });

    it('keeps full-width Firestore int64 values distinct for stale manifests', async () => {
      prefixCounter += 1;
      const prefix = `orchestrator-migration-int64-${Date.now()}-${prefixCounter}-`;
      const store = new FirestoreStore({
        projectId: 'demo-orchestrator',
        databaseId: '(default)',
        collectionPrefix: prefix,
        emulatorHost: emulatorHost ?? 'localhost:8080',
      });
      const taskId = { repo: 'octo/example', issue: 13 } as const;
      const raw = new Firestore({
        projectId: 'demo-orchestrator',
        databaseId: '(default)',
        host: emulatorHost ?? 'localhost:8080',
        ssl: false,
      });
      const ref = raw
        .collection(`${prefix}tasks`)
        .doc(encodeURIComponent(taskKey(taskId)));
      const task = {
        task: taskId,
        runCount: 0,
        updatedAt: '2026-08-15T12:00:00.000Z',
      };
      await ref.set({ task, revision: 9_007_199_254_740_992n });

      const first = await store.inventoryPersistedRecords({
        kind: 'task',
        limit: 1,
      });
      const record = first.records[0];
      if (record?.selector?.kind !== 'task' || !('task' in record.selector)) {
        throw new Error('missing task');
      }
      expect(record.selector.task).toEqual(taskId);

      // These adjacent int64 values both round to the same JavaScript number
      // with the default client. The migration client must fingerprint their
      // exact BigInt representations, then reject this stale replacement.
      await ref.update({ revision: 9_007_199_254_740_993n });
      const second = await store.inventoryPersistedRecords({
        kind: 'task',
        limit: 1,
      });
      expect(second.records[0]?.fingerprint).not.toBe(record.fingerprint);

      const entries = [
        {
          selector: record.selector,
          expectedFingerprint: record.fingerprint,
          replacement: {
            task: { ...task, consecutiveLost: 0, work: { reviewed: true } },
            revision: 1,
          },
        },
      ] as const;
      const preview = await store.previewPersistedMigration(entries);
      await expect(
        store.applyPersistedMigration({
          entries,
          reviewedManifestId: preview.manifestId,
        }),
      ).rejects.toThrow('changed after inventory');
    });
  });
});
