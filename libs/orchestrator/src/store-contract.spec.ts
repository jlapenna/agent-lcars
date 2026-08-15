import { describe } from 'vitest';

import { FirestoreStore } from './firestore-store';
import { MemoryStore } from './memory-store';
import { runOrchestratorStoreContract } from './store-contract';

runOrchestratorStoreContract('MemoryStore', () => new MemoryStore());

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
