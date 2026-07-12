import {
  getFirestoreEmulatorHost,
  getProjectId,
  isEmulator,
} from '@repo/util-server';
import { App, getApps, initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore as getAdminFirestore } from 'firebase-admin/firestore';

import { SessionDoc } from '../lib/types';

/**
 * Dedicated telemetry Firestore database (see #2538), never the app's
 * default database — session docs must stay isolated from app data.
 */
const AGENT_TELEMETRY_DATABASE_ID = 'agent-telemetry';
const SESSIONS_COLLECTION = 'sessions';

let cachedApp: App | null = null;
let cachedFirestore: Firestore | null = null;

function getOrCreateApp(): App {
  if (cachedApp) {
    return cachedApp;
  }
  const apps = getApps();
  cachedApp = (apps[0] as App) ?? initializeApp({ projectId: getProjectId() });
  return cachedApp;
}

/**
 * Firestore client scoped to the `agent-telemetry` database. Real-DB auth
 * relies entirely on ambient Application Default Credentials — a
 * WIF-impersonated token for runner sessions, or the
 * `agent-telemetry-writer` key file for host watchers (see
 * apps/agent-console/infra/agent-telemetry.yaml) — never a credential
 * hardcoded in this module.
 */
export function getAgentTelemetryFirestore(): Firestore {
  if (cachedFirestore) {
    return cachedFirestore;
  }

  const app = getOrCreateApp();
  cachedFirestore = getAdminFirestore(app, AGENT_TELEMETRY_DATABASE_ID);

  const emulatorHost = getFirestoreEmulatorHost();
  if (isEmulator() && emulatorHost) {
    cachedFirestore.settings({ host: emulatorHost, ssl: false });
  }

  return cachedFirestore;
}

/** Upserts a session doc at `sessions/{sessionId}` in the telemetry database. */
export async function upsertSession(doc: SessionDoc): Promise<void> {
  const firestore = getAgentTelemetryFirestore();
  await firestore
    .collection(SESSIONS_COLLECTION)
    .doc(doc.sessionId)
    .set(doc, { merge: true });
}

/** @internal Reset cached clients for testing only. */
export function _resetForTesting(): void {
  cachedApp = null;
  cachedFirestore = null;
}
