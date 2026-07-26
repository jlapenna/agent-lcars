import { Firestore } from '@google-cloud/firestore';
import { assertNotBrowser } from '@repo/util';
import {
  getFirestoreEmulatorHost,
  getProjectId,
  isEmulator,
} from '@repo/util-server';
import { GoogleAuth } from 'google-auth-library';

assertNotBrowser();

// See infra/terraform/main.tf for provisioning (the `agent-telemetry`
// Firestore database and the `apphosting_firestore` grant below).
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
 * database, isolated from the app's default database. In prod this runs as
 * the console's own runtime identity (firebase-app-hosting-compute), granted
 * `roles/datastore.viewer` directly (see infra/terraform/main.tf's
 * `apphosting_firestore`) — no impersonation or key file involved. Distinct
 * from `getAgentTelemetryWriterFirestore` in store.ts, which `upsertSession`
 * uses and this client cannot do.
 */
export function getAgentTelemetryReaderFirestore():
  Firestore | Promise<Firestore> {
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
