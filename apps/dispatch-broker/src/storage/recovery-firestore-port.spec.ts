/** Proves the recovery-operation adapter's behavior against a real Firestore emulator. */

import { buildRecoveryObservation } from '@agent-lcars/dispatch-contracts';
import { expect, test } from 'vitest';

import { runFirestoreEmulatorRecoveryOperationPortContract } from './recovery-firestore-emulator-harness.js';
import { FirestoreRecoveryOperationPort } from './recovery-firestore-port.js';

// Distinct project/port namespace from firestore-port.spec.ts and
// firestore-rest-port.spec.ts so all three emulator users can run
// concurrently -- see recovery-firestore-emulator-harness.ts's header.
runFirestoreEmulatorRecoveryOperationPortContract({
  suiteName: 'FirestoreRecoveryOperationPort',
  projectId: 'demo-recovery-operation-port',
  firestorePort: 4113,
  hubPort: 4413,
  createPort: ({ projectId, emulatorHost }) =>
    new FirestoreRecoveryOperationPort({
      projectId,
      databaseId: '(default)',
      emulatorHost,
    }),
  // Regression coverage for the Codex finding on #875: exactIdentity has no
  // declared upper bound, so a reversible doc-ID encoding of the whole key
  // could exceed Firestore's 1,500-byte document ID limit for an otherwise
  // well-formed observation. docId() hashes instead -- this proves a long
  // exactIdentity actually round-trips through the real emulator rather than
  // failing the write. Registered via `additionalTests`, not a bare
  // top-level `test()`, so it inherits the harness's Java-21 availability
  // gate instead of running unconditionally and failing hard wherever Java
  // is absent (CI's `Verify` job; only `e2e` installs it).
  additionalTests: ({ projectId, emulatorHost }) => {
    test('records and reads back an observation whose exactIdentity is long enough to have broken a reversible doc-ID encoding', async () => {
      const port = new FirestoreRecoveryOperationPort({
        projectId,
        databaseId: '(default)',
        emulatorHost,
      });
      const observation = buildRecoveryObservation({
        target: {
          domain: 'ci_retry',
          repositoryId: 1,
          repository: 'jlapenna/agent-lcars',
          anchor: 1,
          exactIdentity: `run:1:${'a'.repeat(2000)}`,
        },
        sourceKind: 'webhook',
        observedAt: '2026-08-09T00:00:00.000Z',
        evidence: 'https://example.invalid/evidence',
      });
      const recorded = await port.recordObservation(observation);
      expect(recorded.status).toBe('pending');
      const read = await port.readRecoveryOperation(observation.operationKey);
      expect(read?.observation.target.exactIdentity).toBe(
        observation.target.exactIdentity,
      );
    });
  },
});
