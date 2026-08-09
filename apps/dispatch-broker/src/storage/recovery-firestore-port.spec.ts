/** Proves the recovery-operation adapter's behavior against a real Firestore emulator. */

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
});
