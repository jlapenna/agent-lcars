/** Proves the SDK adapter's CAS behavior against a real Firestore emulator. */

import { runFirestoreEmulatorStoragePortContract } from './firestore-emulator-harness.js';
import { FirestoreStoragePort } from './firestore-port.js';

// This namespace is distinct from console E2E and the REST adapter suite, so
// all three emulator users can run concurrently.
runFirestoreEmulatorStoragePortContract({
  suiteName: 'FirestoreStoragePort',
  projectId: 'demo-dispatch-broker-storage-port',
  firestorePort: 4112,
  hubPort: 4412,
  createPort: ({ projectId, emulatorHost }) =>
    new FirestoreStoragePort({
      projectId,
      databaseId: '(default)',
      emulatorHost,
    }),
});
