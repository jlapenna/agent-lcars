import { describe, expect, it } from 'vitest';

import { FirestoreStore } from './firestore-store';
import { MemoryStore } from './memory-store';
import { outboxEntrySchema, taskSchema } from './model';
import { runOrchestratorStoreContract } from './store-contract';

runOrchestratorStoreContract('MemoryStore', () => new MemoryStore());

describe('taskSchema', () => {
  it('reads a legacy task document that predates pendingRequest (and consecutiveLost) fine', () => {
    // No `apply()`/store round trip needed here -- this is the schema
    // itself proving it accepts documents written before this field (or
    // `consecutiveLost`) existed, exactly as `FirestoreStore.readTask`
    // would parse one off a real, older document.
    const legacyDoc: unknown = {
      task: { repo: 'octo/example', issue: 7 },
      activeRunId: 'octo/example#7/r1',
      runCount: 1,
      updatedAt: '2026-08-15T12:00:00.000Z',
    };
    const parsed = taskSchema.parse(legacyDoc);
    expect(parsed.pendingRequest).toBeUndefined();
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

// Only runs against a real Firestore emulator, opted into via
// FIRESTORE_EMULATOR_HOST; otherwise this whole block is skipped so the
// suite still passes hermetically (e.g. in CI without an emulator wired up).
describe.skipIf(emulatorHost === undefined)('FirestoreStore (emulator)', () => {
  let prefixCounter = 0;

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
});
