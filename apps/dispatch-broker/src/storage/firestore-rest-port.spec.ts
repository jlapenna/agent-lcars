/** Proves the REST adapter's CAS behavior against a real Firestore emulator. */

import { runFirestoreEmulatorStoragePortContract } from './firestore-emulator-harness.js';
import { FirestoreRestStoragePort } from './firestore-rest-port.js';

// Separate project and ports are part of the shared harness's isolation
// contract; do not reuse the SDK suite's 4112/4412 namespace here.
runFirestoreEmulatorStoragePortContract({
  suiteName: 'FirestoreRestStoragePort',
  projectId: 'demo-dispatch-broker-storage-port-rest',
  firestorePort: 4113,
  hubPort: 4413,
  createPort: ({ projectId, emulatorHost }) =>
    new FirestoreRestStoragePort({
      projectId,
      databaseId: '(default)',
      // The emulator's documented admin token; production still supplies a
      // real access token from google-github-actions/auth.
      token: 'owner',
      emulatorHost,
    }),
});
