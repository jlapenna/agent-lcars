import { describe, expect, it } from 'vitest';

import { MemoryStore } from './memory-store';
import {
  fingerprint,
  inventoryPersistedRecord,
  manifestId,
  PersistedMigrationConflict,
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
          code: 'retired-top-level-retiredDocumentField',
          class: 'compatibility',
        },
        { code: 'retired-top-level-retiredTaskField', class: 'compatibility' },
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
      leaseExpiresAt: T,
      events: [{ at: T, to: 'lost', by: 'infra' }],
      createdAt: T,
      updatedAt: T,
      retiredRunField: true,
    });
    expect(run.selector).toEqual({ kind: 'run', runId: 'octo/example#7/r1' });
    expect(run.findings).toEqual(
      expect.arrayContaining([
        { code: 'infra-event-0', class: 'compatibility' },
        { code: 'retired-top-level-retiredRunField', class: 'compatibility' },
        { code: 'missing-params', class: 'optional' },
        { code: 'missing-queue', class: 'optional' },
        { code: 'missing-result', class: 'optional' },
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
          code: 'retired-top-level-retiredOutboxField',
          class: 'compatibility',
        },
        { code: 'missing-firstFailedAt', class: 'optional' },
        { code: 'missing-nextAttemptAt', class: 'optional' },
        { code: 'missing-deliveryFailures', class: 'optional' },
      ]),
    );
    // A census record has only selector/fingerprint/finding labels, never a
    // copied persisted payload.
    expect(Object.keys(outbox)).toEqual([
      'selector',
      'fingerprint',
      'findings',
    ]);
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
    const record = inventory.records[0];
    if (record?.selector?.kind !== 'task') throw new Error('missing task');
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
});
