import { Firestore, GeoPoint, Timestamp } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';

import { MemoryStore } from './memory-store';
import {
  decodePersistedMigrationAddress,
  decodePersistedMigrationCursor,
  encodePersistedMigrationAddress,
  encodePersistedMigrationCursor,
  fingerprint,
  inventoryPersistedRecord,
  manifestId,
  PERSISTED_MIGRATION_ADDRESS_MAX_LENGTH,
  PERSISTED_MIGRATION_CURSOR_MAX_LENGTH,
  PersistedMigrationConflict,
  PersistedMigrationCursorError,
} from './persisted-record-migration';

const T = '2026-08-15T12:00:00.000Z';

describe('persisted orchestrator record inventory', () => {
  it('censuses every fixed collection without exposing document values', () => {
    const task = inventoryPersistedRecord('task', {
      task: {
        task: { repo: 'octo/example', issue: 7 },
        runCount: 0,
        updatedAt: T,
        retiredTaskField: true,
      },
      revision: 1,
      retiredDocumentField: true,
    });
    expect(task.selector).toEqual({
      kind: 'task',
      task: { repo: 'octo/example', issue: 7 },
    });
    expect(task.findings).toEqual(
      expect.arrayContaining([
        {
          code: 'retired-task-document-fields',
          class: 'compatibility',
        },
        { code: 'retired-task-fields', class: 'compatibility' },
        { code: 'missing-consecutiveLost', class: 'compatibility' },
        { code: 'missing-work', class: 'compatibility' },
      ]),
    );

    const run = inventoryPersistedRecord('run', {
      runId: 'octo/example#7/r1',
      task: { repo: 'octo/example', issue: 7 },
      state: 'lost',
      pipeline: 'codex',
      requestId: 'delivery-1',
      requestSource: 'caller',
      leaseExpiresAt: T,
      events: [{ at: T, to: 'lost', by: 'infra' }],
      createdAt: T,
      updatedAt: T,
      retiredRunField: true,
    });
    expect(run.selector).toEqual({ kind: 'run', runId: 'octo/example#7/r1' });
    expect(run.findings).toEqual(
      expect.arrayContaining([
        { code: 'infra-run-events', class: 'compatibility' },
        { code: 'retired-run-fields', class: 'compatibility' },
        { code: 'missing-params', class: 'optional' },
        { code: 'missing-queue', class: 'optional' },
        { code: 'missing-result', class: 'optional' },
      ]),
    );

    const legacyRun = inventoryPersistedRecord('run', {
      runId: 'octo/example#7/r0',
      task: { repo: 'octo/example', issue: 7 },
      state: 'lost',
      pipeline: 'codex',
      requestId: 'delivery-0',
      leaseExpiresAt: T,
      events: [],
      createdAt: T,
      updatedAt: T,
    });
    expect(legacyRun.findings).toEqual(
      expect.arrayContaining([
        { code: 'missing-requestSource', class: 'compatibility' },
      ]),
    );

    const outbox = inventoryPersistedRecord('outbox', {
      entryId: 'dispatch/octo/example#7/r1',
      kind: 'dispatch-run',
      task: { repo: 'octo/example', issue: 7 },
      runId: 'octo/example#7/r1',
      state: 'pending',
      attempts: 0,
      createdAt: T,
      updatedAt: T,
      retiredOutboxField: true,
    });
    expect(outbox.selector).toEqual({
      kind: 'outbox',
      entryId: 'dispatch/octo/example#7/r1',
    });
    expect(outbox.findings).toEqual(
      expect.arrayContaining([
        {
          code: 'retired-outbox-fields',
          class: 'compatibility',
        },
        { code: 'missing-firstFailedAt', class: 'optional' },
        { code: 'missing-nextAttemptAt', class: 'optional' },
        { code: 'missing-deliveryFailures', class: 'optional' },
      ]),
    );
    // A census record has only selector/fingerprint/finding labels, never a
    // copied persisted payload.
    expect(outbox).toMatchObject({
      findingCount: outbox.findings.length,
      findingsTruncated: false,
    });
  });

  it('uses only its closed finding-code vocabulary and a bounded cursor', () => {
    const inventory = inventoryPersistedRecord('task', {
      task: {
        task: { repo: 'octo/example', issue: 7 },
        runCount: 0,
        updatedAt: T,
        ...Object.fromEntries(
          Array.from({ length: 500 }, (_, index) => [`retired${index}`, true]),
        ),
      },
      revision: 1,
      ...Object.fromEntries(
        Array.from({ length: 500 }, (_, index) => [`retired${index}`, true]),
      ),
    });
    expect(inventory).toMatchObject({
      findingCount: 7,
      findingsTruncated: false,
    });
    expect(inventory.findings).toEqual(
      expect.arrayContaining([
        { code: 'retired-task-document-fields', class: 'compatibility' },
        { code: 'retired-task-fields', class: 'compatibility' },
      ]),
    );
    const documentId = '\\'.repeat(1_500);
    const cursor = encodePersistedMigrationCursor('task', documentId);
    expect(cursor.length).toBeLessThanOrEqual(
      PERSISTED_MIGRATION_CURSOR_MAX_LENGTH,
    );
    expect(decodePersistedMigrationCursor(cursor, 'task')).toBe(documentId);
  });

  it('rejects cursor ids that cannot name one direct Firestore document', () => {
    const directPathCursor = Buffer.concat([
      Buffer.from([0x74]),
      Buffer.from('a/b', 'utf8'),
    ]).toString('base64url');

    expect(() =>
      decodePersistedMigrationCursor(directPathCursor, 'task'),
    ).toThrow(PersistedMigrationCursorError);
    expect(() => encodePersistedMigrationCursor('task', 'a/b')).toThrow(
      PersistedMigrationCursorError,
    );
  });

  it('uses a bounded opaque address for malformed fixed-collection records', () => {
    const taskDocumentId = encodeURIComponent('octo/example#31');
    const runDocumentId = encodeURIComponent('octo/example#31/r1');
    const outboxDocumentId = encodeURIComponent('dispatch/octo/example#31/r1');
    const records = [
      [
        'task',
        taskDocumentId,
        { task: { runCount: 0, updatedAt: T }, revision: 1 },
      ],
      [
        'run',
        runDocumentId,
        {
          task: { repo: 'octo/example', issue: 31 },
          state: 'lost',
          pipeline: 'codex',
        },
      ],
      [
        'outbox',
        outboxDocumentId,
        { kind: 'dispatch-run', state: 'pending', attempts: 0 },
      ],
    ] as const;

    for (const [kind, documentId, value] of records) {
      const inventory = inventoryPersistedRecord(kind, value, documentId);
      expect(inventory.selector).toEqual({
        kind,
        address: encodePersistedMigrationAddress(kind, documentId),
      });
      expect(JSON.stringify(inventory)).not.toContain(documentId);
    }

    const address = encodePersistedMigrationAddress('run', '\\'.repeat(1_500));
    expect(address.length).toBeLessThanOrEqual(
      PERSISTED_MIGRATION_ADDRESS_MAX_LENGTH,
    );
    expect(decodePersistedMigrationAddress(address, 'run')).toBe(
      '\\'.repeat(1_500),
    );
    expect(() => decodePersistedMigrationAddress(address, 'task')).toThrow(
      PersistedMigrationCursorError,
    );
  });

  it('fingerprints special numbers and Firestore value types distinctly', () => {
    const specialNumbers = [NaN, Infinity, -Infinity, -0, 0];
    expect(new Set(specialNumbers.map(fingerprint))).toHaveLength(5);
    expect(fingerprint(new Timestamp(7, 9))).not.toBe(
      fingerprint({ seconds: 7, nanoseconds: 9 }),
    );
    expect(fingerprint(new GeoPoint(1, 2))).not.toBe(
      fingerprint({ latitude: 1, longitude: 2 }),
    );
    expect(fingerprint(Buffer.from([1, 2]))).not.toBe(fingerprint('AQI'));
    const firstReference = new Firestore({ projectId: 'fingerprint-a' }).doc(
      'records/one',
    );
    const secondReference = new Firestore({ projectId: 'fingerprint-b' }).doc(
      'records/one',
    );
    expect(fingerprint(firstReference)).not.toBe(fingerprint(secondReference));
    expect(fingerprint(firstReference)).not.toBe(
      fingerprint({ path: 'records/one' }),
    );
  });
});

describe('reviewed persisted-record manifest', () => {
  it('is dry-run addressable, bounded-pageable, and refuses a stale apply', async () => {
    const store = new MemoryStore();
    const task = {
      task: { repo: 'octo/example', issue: 7 },
      runCount: 0,
      updatedAt: T,
    };
    // Seed through the store's ordinary public decision boundary. This is a
    // legacy-shaped task document (no work/consecutiveLost) by design.
    await store.apply({
      decision: { task, outbox: [] },
      expectedRevision: undefined,
    });
    const inventory = await store.inventoryPersistedRecords({
      kind: 'task',
      limit: 1,
    });
    expect(inventory.hasMore).toBe(false);
    expect(inventory.consistency).toBe('page-only');
    const record = inventory.records[0];
    if (record?.selector?.kind !== 'task' || !('task' in record.selector)) {
      throw new Error('missing task');
    }
    const entry = {
      selector: record.selector,
      expectedFingerprint: record.fingerprint,
      replacement: {
        task: { ...task, consecutiveLost: 0, work: { migration: 'reviewed' } },
        revision: 1,
      },
    } as const;
    const preview = await store.previewPersistedMigration([entry]);
    expect(preview.manifestId).toBe(manifestId([entry]));
    expect(preview.deletions).toEqual([]);
    await expect(
      store.previewPersistedMigration([{ ...entry, operation: 'replace' }]),
    ).resolves.toMatchObject({ deletions: [] });
    await expect(
      store.applyPersistedMigration({
        entries: [entry],
        reviewedManifestId: fingerprint('wrong-manifest'),
      }),
    ).rejects.toThrow(PersistedMigrationConflict);
    await store.applyPersistedMigration({
      entries: [entry],
      reviewedManifestId: preview.manifestId,
    });
    expect((await store.readTask(task.task))?.task).toMatchObject({
      consecutiveLost: 0,
      work: { migration: 'reviewed' },
    });
  });

  it('deletes only reviewed terminal compatibility records with bounded dependencies', async () => {
    const store = new MemoryStore();
    const task = {
      task: { repo: 'octo/example', issue: 71 },
      runCount: 1,
      updatedAt: T,
    };
    const run = {
      runId: 'octo/example#71/r1',
      task: task.task,
      state: 'lost' as const,
      pipeline: 'codex',
      requestId: 'legacy-run',
      leaseExpiresAt: T,
      events: [],
      createdAt: T,
      updatedAt: T,
    };
    const pending = {
      entryId: `dispatch/${run.runId}`,
      kind: 'dispatch-run' as const,
      task: task.task,
      runId: run.runId,
      state: 'pending' as const,
      attempts: 0,
      createdAt: T,
      updatedAt: T,
    };
    await store.apply({
      decision: { task, run, outbox: [pending] },
      expectedRevision: undefined,
    });
    const record = (
      await store.inventoryPersistedRecords({ kind: 'run', limit: 1 })
    ).records[0];
    if (record?.selector?.kind !== 'run' || !('runId' in record.selector)) {
      throw new Error('missing run inventory selector');
    }
    const entry = {
      operation: 'delete' as const,
      selector: record.selector,
      expectedFingerprint: record.fingerprint,
    };
    const blocked = await store.previewPersistedMigration([entry]);
    expect(blocked.deletions).toEqual([
      expect.objectContaining({
        selector: record.selector,
        status: 'blocked',
        reasons: expect.arrayContaining(['pending-outbox']),
      }),
    ]);

    const taskBeforeRunDelete = (
      await store.inventoryPersistedRecords({ kind: 'task', limit: 1 })
    ).records[0];
    if (
      taskBeforeRunDelete?.selector?.kind !== 'task' ||
      !('task' in taskBeforeRunDelete.selector)
    ) {
      throw new Error('missing task inventory selector');
    }
    const childRunBlocked = await store.previewPersistedMigration([
      {
        operation: 'delete',
        selector: taskBeforeRunDelete.selector,
        expectedFingerprint: taskBeforeRunDelete.fingerprint,
      },
    ]);
    expect(childRunBlocked.deletions[0]).toMatchObject({
      status: 'blocked',
      reasons: expect.arrayContaining(['child-run-present']),
    });

    const current = await store.readTask(task.task);
    if (current === undefined) throw new Error('missing task');
    await store.apply({
      decision: { task: current.task, outbox: [{ ...pending, state: 'done' }] },
      expectedRevision: current.revision,
    });
    const ready = await store.previewPersistedMigration([entry]);
    expect(ready.deletions).toEqual([
      { selector: record.selector, status: 'ready', reasons: [] },
    ]);
    await store.applyPersistedMigration({
      entries: [entry],
      reviewedManifestId: ready.manifestId,
    });
    expect(await store.readRun(run.runId)).toBeUndefined();

    const taskRecord = (
      await store.inventoryPersistedRecords({ kind: 'task', limit: 1 })
    ).records[0];
    if (
      taskRecord?.selector?.kind !== 'task' ||
      !('task' in taskRecord.selector)
    ) {
      throw new Error('missing task inventory selector');
    }
    const taskDelete = {
      operation: 'delete' as const,
      selector: taskRecord.selector,
      expectedFingerprint: taskRecord.fingerprint,
    };
    const taskPreview = await store.previewPersistedMigration([taskDelete]);
    expect(taskPreview.deletions).toEqual([
      { selector: taskRecord.selector, status: 'ready', reasons: [] },
    ]);
    await store.applyPersistedMigration({
      entries: [taskDelete],
      reviewedManifestId: taskPreview.manifestId,
    });
    expect(await store.readTask(task.task)).toBeUndefined();
  });

  it('refuses optional-only outbox records and a saturated run dependency bound', async () => {
    const store = new MemoryStore();
    const task = {
      task: { repo: 'octo/example', issue: 72 },
      runCount: 1,
      updatedAt: T,
    };
    const run = {
      runId: 'octo/example#72/r1',
      task: task.task,
      state: 'finished' as const,
      pipeline: 'codex',
      requestId: 'legacy-run',
      leaseExpiresAt: T,
      events: [],
      createdAt: T,
      updatedAt: T,
    };
    const dependencies = [0, 1, 2].map((index) => ({
      entryId: `report/${run.runId}/${index}`,
      kind: 'report-outcome' as const,
      task: task.task,
      runId: run.runId,
      state: 'done' as const,
      attempts: 0,
      createdAt: T,
      updatedAt: T,
    }));
    await store.apply({
      decision: { task, run, outbox: dependencies },
      expectedRevision: undefined,
    });
    const runRecord = (
      await store.inventoryPersistedRecords({ kind: 'run', limit: 1 })
    ).records[0];
    if (
      runRecord?.selector?.kind !== 'run' ||
      !('runId' in runRecord.selector)
    ) {
      throw new Error('missing run inventory selector');
    }
    const runPreview = await store.previewPersistedMigration([
      {
        operation: 'delete',
        selector: runRecord.selector,
        expectedFingerprint: runRecord.fingerprint,
      },
    ]);
    expect(runPreview.deletions[0]).toMatchObject({
      status: 'blocked',
      reasons: expect.arrayContaining(['outbox-dependency-over-limit']),
    });

    const outboxRecord = (
      await store.inventoryPersistedRecords({ kind: 'outbox', limit: 1 })
    ).records[0];
    if (
      outboxRecord?.selector?.kind !== 'outbox' ||
      !('entryId' in outboxRecord.selector)
    ) {
      throw new Error('missing outbox inventory selector');
    }
    const outboxPreview = await store.previewPersistedMigration([
      {
        operation: 'delete',
        selector: outboxRecord.selector,
        expectedFingerprint: outboxRecord.fingerprint,
      },
    ]);
    expect(outboxPreview.deletions[0]).toMatchObject({
      status: 'blocked',
      reasons: ['no-compatibility-finding'],
    });
  });
});
