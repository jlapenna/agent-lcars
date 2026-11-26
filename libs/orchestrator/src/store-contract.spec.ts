import type { TrackerIssue } from '@agent-lcars/dispatch-contracts';
import { Firestore } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';

import { decidedRun, isRefusal } from './decide';
import { FirestoreScheduleStore } from './firestore-schedule-store';
import { FirestoreStore } from './firestore-store';
import { readRunIssue } from './issue-snapshot';
import { MemoryScheduleStore } from './memory-schedule-store';
import { MemoryStore } from './memory-store';
import {
  outboxEntrySchema,
  type QueuePriority,
  taskKey,
  taskSchema,
} from './model';
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

describe('MemoryStore exhaustive reads', () => {
  it('computes lifecycle metrics and queue admission from more than 1,000 runs', async () => {
    const now = '2026-08-15T12:00:00.000Z';
    const store = new MemoryStore();
    const orchestrator = new Orchestrator(store, { now: () => now });
    for (let issue = 1; issue <= 1001; issue++) {
      const result = await orchestrator.request({
        taskId: { repo: 'octo/example', issue },
        requestId: `many-${issue}`,
        pipeline: 'claude',
        work: { spec: { title: 'exhaustive read regression' } },
      });
      if (isRefusal(result)) throw new Error('unexpected refusal');
      await store.enqueueRun({ runId: decidedRun(result).runId, now });
    }
    const records = await store.readLifecycleMetricRecords({
      since: now,
      until: now,
    });
    expect(records.complete).toBe(true);
    expect(records.recentRuns).toHaveLength(1001);
    expect(records.liveRuns).toHaveLength(1001);
    expect(records.outstandingOutbox).toHaveLength(1001);
    expect(
      (await store.readQueueAdmissionStatus({ pipelines: ['claude'], now }))
        .providers[0],
    ).toMatchObject({ queued: 1001 });
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

  it('repairs only legacy terminal queued records and can run again after completion', async () => {
    const collectionPrefix = `terminal-queue-repair-${crypto.randomUUID()}-`;
    const options = {
      projectId: 'demo-orchestrator',
      databaseId: '(default)',
      collectionPrefix,
      emulatorHost: emulatorHost ?? 'localhost:8080',
    };
    const firestore = new Firestore({
      projectId: options.projectId,
      databaseId: options.databaseId,
      host: options.emulatorHost,
      ssl: false,
    });
    const store = new FirestoreStore(options);
    const runs = firestore.collection(`${collectionPrefix}runs`);
    const records = [
      ['canceled', 'queued'],
      ['finished', 'queued'],
      ['lost', 'queued'],
      ['pending', 'queued'],
      ['running', 'queued'],
      ['finished', 'claimed'],
      ['canceled', 'retired'],
    ] as const;
    try {
      for (const [index, [state, queueState]] of records.entries()) {
        await runs.doc(String(index)).set({
          state,
          queue: { state: queueState, preserved: index },
          updatedAt: '2026-08-15T12:00:00.000Z',
        });
      }

      expect(await store.retireTerminalQueueBatch()).toBe(3);
      expect(await store.retireTerminalQueueBatch()).toBe(0);
      for (const [index, [state, queueState]] of records.entries()) {
        expect((await runs.doc(String(index)).get()).data()).toEqual({
          state,
          queue: {
            state: index < 3 ? 'retired' : queueState,
            preserved: index,
          },
          updatedAt: '2026-08-15T12:00:00.000Z',
        });
      }
    } finally {
      await firestore.terminate();
    }
  });

  it('backfills embedded run issues with resumable pages and leaves an existing snapshot intact', async () => {
    const now = '2026-08-15T12:00:00.000Z';
    const options = {
      projectId: 'demo-orchestrator',
      databaseId: '(default)',
      collectionPrefix: `orchestrator-test-issues-${crypto.randomUUID()}-`,
      emulatorHost: emulatorHost ?? 'localhost:8080',
      readPageSize: 1,
    };
    const firestore = new Firestore({
      projectId: options.projectId,
      databaseId: options.databaseId,
      host: options.emulatorHost,
      ssl: false,
    });
    try {
      const store = new FirestoreStore(options);
      const orchestrator = new Orchestrator(store, { now: () => now });
      const taskId = { repo: 'octo/example', issue: 7 };
      const issue = {
        reference: { tracker: 'github', ...taskId },
        title: 'Before migration',
        identifier: 'octo/example#7',
        url: 'https://github.com/octo/example/issues/7',
        description: 'Immutable body',
        state: 'open',
        updatedAt: now,
        labels: [],
        assignees: [],
      } satisfies TrackerIssue;
      const admitted = await orchestrator.request({
        taskId,
        requestId: 'current',
        pipeline: 'codex',
        work: { spec: { title: 'Migration fixture' } },
        issue,
      });
      if (isRefusal(admitted)) throw new Error(admitted.reason);
      const run = decidedRun(admitted);
      const stored = firestore.collection(`${options.collectionPrefix}runs`);
      const { issueSnapshot, ...fields } = run;
      const legacyId = `${taskId.repo}#${taskId.issue}/r2`;
      await stored
        .doc(encodeURIComponent(legacyId))
        .set({ ...fields, runId: legacyId, issue });
      const snapshots = firestore.collection(
        `${options.collectionPrefix}issue-snapshots`,
      );
      const snapshot = snapshots.doc(issueSnapshot!.id);
      const original = await snapshot.get();

      const dryRun = await store.migrateRunIssueSnapshots({ apply: false });
      expect(dryRun).toMatchObject({ scanned: 1, candidates: 0, migrated: 0 });
      expect(dryRun.nextCursor).toBe(encodeURIComponent(run.runId));
      const legacyPage = { cursor: dryRun.nextCursor };
      expect(
        await store.migrateRunIssueSnapshots({ ...legacyPage, apply: false }),
      ).toMatchObject({ scanned: 1, candidates: 1, migrated: 0 });
      expect(
        (await stored.doc(encodeURIComponent(legacyId)).get()).get('issue'),
      ).toEqual(issue);

      expect(
        await store.migrateRunIssueSnapshots({ ...legacyPage, apply: true }),
      ).toMatchObject({ scanned: 1, candidates: 1, migrated: 1 });
      const migrated = (await store.readRun(legacyId))!;
      expect(migrated).not.toHaveProperty('issue');
      expect(migrated.issueSnapshot).toEqual(issueSnapshot);
      expect(await readRunIssue(store, migrated)).toEqual(issue);
      expect(
        await store.migrateRunIssueSnapshots({ ...legacyPage, apply: true }),
      ).toMatchObject({ scanned: 1, candidates: 0, migrated: 0 });
      expect((await snapshots.get()).size).toBe(1);
      expect((await snapshot.get()).updateTime).toEqual(original.updateTime);
      expect((await store.readTask(taskId))?.task.issue).toEqual(issue);
    } finally {
      await firestore.terminate();
    }
  });

  it('falls back to raw native pages after an older writer replaces a task projection', async () => {
    const collectionPrefix = `native-state-rollback-${crypto.randomUUID()}-`;
    const projectId = 'demo-orchestrator';
    const host = emulatorHost ?? 'localhost:8080';
    const firestore = new Firestore({ projectId, host, ssl: false });
    const store = new FirestoreStore({
      projectId,
      databaseId: '(default)',
      collectionPrefix,
      emulatorHost: host,
    });
    const older = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3A' };
    const newer = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3B' };
    try {
      const orchestrator = new Orchestrator(store, {
        now: () => '2026-08-15T12:00:00.000Z',
      });
      for (const taskId of [older, newer]) {
        const requested = await orchestrator.request({
          taskId,
          requestId: taskId.workId,
          pipeline: 'claude',
          work: { origin: { principal: 'user:jlapenna' } },
        });
        if (isRefusal(requested)) throw new Error(requested.reason);
        if (taskId === older)
          await orchestrator.report(decidedRun(requested).runId, { ok: true });
      }

      const [indexed] = await store.listNativeTasks(1, undefined, 'done');
      expect(indexed.task.task).toEqual(older);
      const { task, revision } = indexed;
      await firestore
        .collection(`${collectionPrefix}tasks`)
        .doc(encodeURIComponent(taskKey(older)))
        .set({ task, revision });

      const [first] = await store.listNativeTasks(1, undefined, 'done');
      expect(first.task.task).toEqual(newer);
      const [second] = await store.listNativeTasks(1, newer.workId, 'done');
      expect(second.task.task).toEqual(older);
      expect(second.derived).toBeUndefined();

      expect(await store.refreshTaskDerived(older)).toBe(true);
      expect(await store.listNativeTasks(1, undefined, 'done')).toEqual([
        indexed,
      ]);
    } finally {
      await firestore.terminate();
    }
  });

  it('persists priority turns across store restart and refuses a corrupt cursor without claiming', async () => {
    const now = '2026-08-15T12:00:00.000Z';
    const collectionPrefix = `orchestrator-test-priority-${crypto.randomUUID()}-`;
    const options = {
      projectId: 'demo-orchestrator',
      databaseId: '(default)',
      collectionPrefix,
      emulatorHost: emulatorHost ?? 'localhost:8080',
    };
    const firestore = new Firestore({
      projectId: options.projectId,
      databaseId: options.databaseId,
      host: options.emulatorHost,
      ssl: false,
    });
    try {
      const store = new FirestoreStore(options);
      const orchestrator = new Orchestrator(store, { now: () => now });
      for (const [index, priority] of (
        [
          'urgent',
          'urgent',
          'urgent',
          'normal',
          'background',
        ] satisfies QueuePriority[]
      ).entries()) {
        const result = await orchestrator.request({
          taskId: { repo: 'octo/example', issue: index + 1001 },
          requestId: `priority-${index}`,
          pipeline: 'claude',
          priority,
          work: { spec: { title: 'priority restart regression' } },
        });
        if (isRefusal(result)) throw new Error('unexpected refusal');
        await store.enqueueRun({ runId: decidedRun(result).runId, now });
      }
      const claim = {
        pipelines: ['claude'],
        now,
        claimedBy: 'priority-test',
        claimedBySubject: 'executor@example.com',
        tokenHash: 'a'.repeat(64),
      };
      expect((await store.claimQueuedRun(claim))?.priority).toBe('urgent');
      expect((await store.claimQueuedRun(claim))?.priority).toBe('urgent');
      const restarted = new FirestoreStore(options);
      expect((await restarted.claimQueuedRun(claim))?.priority).toBe('normal');
      const cursor = firestore
        .collection(`${collectionPrefix}priority-positions`)
        .doc('claude');
      expect((await cursor.get()).data()).toEqual({ position: 3 });
      const before = await restarted.listQueuedRuns();
      await cursor.set({ position: 7 });
      await expect(restarted.claimQueuedRun(claim)).rejects.toThrow();
      expect(await restarted.listQueuedRuns()).toEqual(before);
    } finally {
      await firestore.terminate();
    }
  });

  it('rejects malformed cooldowns and counts every live run across read pages', async () => {
    const prefix = `admission-bounds-${Date.now()}-`;
    const firestore = new Firestore({
      projectId: 'demo-orchestrator',
      databaseId: '(default)',
      host: emulatorHost ?? 'localhost:8080',
      ssl: false,
    });
    const store = new FirestoreStore({
      projectId: 'demo-orchestrator',
      databaseId: '(default)',
      collectionPrefix: prefix,
      emulatorHost: emulatorHost ?? 'localhost:8080',
    });
    const now = '2026-10-09T23:00:00.000Z';
    const outcome = await new Orchestrator(store, { now: () => now }).request({
      taskId: { repo: 'octo/example', issue: 999 },
      requestId: 'bounded-read',
      pipeline: 'claude',
      work: { spec: { title: 'Admission read regression' } },
    });
    if (isRefusal(outcome)) throw new Error('unexpected refusal');
    const run = decidedRun(outcome);
    const input = { pipelines: ['claude'], now };
    expect(
      (await store.readQueueAdmissionStatus(input)).providers[0],
    ).toMatchObject({ queued: 0, liveClaims: 0 });
    const cooldown = firestore
      .collection(`${prefix}provider-cooldowns`)
      .doc('claude');
    await cooldown.set({
      pipeline: 'claude',
      runId: run.runId,
      observedAt: now,
      expiresAt: 'not-a-time',
    });
    await expect(store.readQueueAdmissionStatus(input)).rejects.toThrow(
      'Invalid provider cooldown',
    );
    await cooldown.delete();
    // 1,000 queued copies plus the original: more than one default read page.
    for (let batchIndex = 0; batchIndex < 2; batchIndex++) {
      const batch = firestore.batch();
      for (let index = 0; index < 500; index++) {
        const id = `bounded-${batchIndex}-${index}`;
        batch.set(firestore.collection(`${prefix}runs`).doc(id), {
          ...run,
          runId: id,
          queue: { state: 'queued' },
        });
      }
      await batch.commit();
    }
    expect(
      (await store.readQueueAdmissionStatus(input)).providers[0],
    ).toMatchObject({ queued: 1000 });
    const records = await store.readLifecycleMetricRecords({
      since: now,
      until: now,
    });
    expect(records).toMatchObject({ complete: true });
    expect(records.recentRuns).toHaveLength(1001);
    expect(records.liveRuns).toHaveLength(1001);
    // A small page size walks the same reads across many cursor pages.
    const paged = new FirestoreStore({
      projectId: 'demo-orchestrator',
      databaseId: '(default)',
      collectionPrefix: prefix,
      emulatorHost: emulatorHost ?? 'localhost:8080',
      readPageSize: 7,
    });
    expect(
      (await paged.readQueueAdmissionStatus(input)).providers[0],
    ).toMatchObject({ queued: 1000 });
    const pagedRecords = await paged.readLifecycleMetricRecords({
      since: now,
      until: now,
    });
    expect(pagedRecords.recentRuns).toHaveLength(1001);
    expect(pagedRecords.liveRuns).toHaveLength(1001);
    expect(
      new Set(pagedRecords.recentRuns.map((record) => record.runId)).size,
    ).toBe(1001);
    await firestore.terminate();
  });

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
