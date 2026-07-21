import { Firestore } from '@google-cloud/firestore';
import { assertNotBrowser } from '@repo/util';
import {
  getFirestoreEmulatorHost,
  getProjectId,
  isEmulator,
} from '@repo/util-server';
import { GoogleAuth } from 'google-auth-library';

assertNotBrowser();

// Source-of-truth inventory: infra-inventory/agent-telemetry.yaml.
// Not secrets - a database id and a service account email are identifiers,
// not credentials. The console's runtime SA (firebase-app-hosting-compute)
// is already granted roles/iam.serviceAccountTokenCreator on this reader SA
// (see the yaml), so no key file or secret is needed to impersonate it.
export const AGENT_TELEMETRY_DATABASE_ID =
  process.env['AGENT_TELEMETRY_DATABASE_ID'] ?? '(default)';

let cachedFirestore: Firestore | Promise<Firestore> | undefined;

function buildFirestore(projectId: string): Firestore {
  return new Firestore({
    projectId,
    databaseId: AGENT_TELEMETRY_DATABASE_ID,
    auth: new GoogleAuth({ projectId }),
  });
}

/**
 * Read-only Firestore client scoped to the dedicated `agent-telemetry`
 * database, isolated from the app's default database. In prod this
 * impersonates the read-only `agent-telemetry-reader` SA (never the broad
 * runtime identity); against the emulator it connects directly, same as
 * `@repo/firebase-server`. Distinct from `getAgentTelemetryWriterFirestore`
 * in store.ts, which `upsertSession` uses and this client cannot do.
 */
export function getAgentTelemetryReaderFirestore(): Firestore | Promise<Firestore> {
  if (cachedFirestore) {
    return cachedFirestore;
  }

  const projectId = getProjectId();
  const emulatorHost = getFirestoreEmulatorHost();

  if (isEmulator() && emulatorHost) {
    cachedFirestore = new Firestore({
      projectId,
      databaseId: AGENT_TELEMETRY_DATABASE_ID,
      host: emulatorHost,
      ssl: false,
    });
    return cachedFirestore;
  }

  cachedFirestore = buildFirestore(projectId);
  return cachedFirestore;
}
