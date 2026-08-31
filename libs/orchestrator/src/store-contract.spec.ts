import { Firestore } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';

import { FirestoreScheduleStore } from './firestore-schedule-store';
import { FirestoreStore } from './firestore-store';
import { MemoryScheduleStore } from './memory-schedule-store';
import { MemoryStore } from './memory-store';
import { outboxEntrySchema, taskSchema } from './model';
import { Orchestrator } from './orchestrator';
import {
  runOrchestratorStoreContract,
  runScheduleStoreContract,
} from './store-contract';

runOrchestratorStoreContract('MemoryStore', () => new MemoryStore());
runScheduleStoreContract(
  'MemoryScheduleStore',
  () => new MemoryScheduleStore(),
);

describe('strict persisted Task/Run/Outbox schemas', () => {
  const now = '2026-08-15T12:00:00.000Z';

  it('rejects Task records that lack cutover-required Work fields', () => {
    const base = {
      task: { repo: 'octo/example', issue: 7 },
      runCount: 1,
      updatedAt: now,
    };
    expect(taskSchema.safeParse(base).success).toBe(false);
    expect(taskSchema.safeParse({ ...base, consecutiveLost: 0 }).success).toBe(
      false,
    );
    expect(
      taskSchema.safeParse({ ...base, work: { migrated: true } }).success,
    ).toBe(false);
  });

  it('keeps absent outbox failure bookkeeping as current no-failure state', () => {
    expect(
      outboxEntrySchema.parse({
        entryId: 'dispatch/octo/example#7/r1',
        kind: 'dispatch-run',
        task: { repo: 'octo/example', issue: 7 },
        runId: 'octo/example#7/r1',
        state: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      }),
    ).toMatchObject({ state: 'pending' });
  });
});

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

if (
  process.env['REQUIRE_FIRESTORE_EMULATOR'] === '1' &&
  emulatorHost === undefined
) {
  throw new Error(
    'REQUIRE_FIRESTORE_EMULATOR=1 but FIRESTORE_EMULATOR_HOST is unset',
  );
}

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
        work: { spec: { title: 'strict Task work' } },
      }),
    ).resolves.toMatchObject({
      run: { requestId: 'requested-key', requestSource: 'caller' },
    });

    await firestore.terminate();
  });

  runOrchestratorStoreContract('FirestoreStore', () => {
    prefixCounter += 1;
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
});
