import {
  getFirestoreEmulatorHost,
  getProjectId,
  isEmulator,
} from '@repo/util-server';
import { App, getApps, initializeApp } from 'firebase-admin/app';
import {
  Firestore as AdminFirestore,
  getFirestore as getAdminFirestore,
} from 'firebase-admin/firestore';
import { Firestore } from '@google-cloud/firestore';

import { SessionDoc } from '../lib/types';
import { AGENT_TELEMETRY_DATABASE_ID } from './firestore-client';

export const SESSIONS_COLLECTION = 'sessions';

let cachedApp: App | null = null;
let cachedWriterFirestore: AdminFirestore | null = null;

function getOrCreateApp(): App {
  if (cachedApp) {
    return cachedApp;
  }
  const apps = getApps();
  cachedApp = (apps[0] as App) ?? initializeApp({ projectId: getProjectId() });
  return cachedApp;
}

/**
 * Write-side Firestore client for the `agent-telemetry` database, used only
 * by `upsertSession` (the CLI `agent-telemetry upsert` command / host
 * watchers). Relies on ambient Application Default Credentials — a
 * WIF-impersonated token for runner sessions, or the
 * `agent-telemetry-writer` key file for host watchers (see
 * apps/agent-console/infra/agent-telemetry.yaml) — never a credential
 * hardcoded in this module. Distinct from `getAgentTelemetryReaderFirestore`
 * in firestore-client.ts, which the console impersonates read-only and
 * cannot use to write.
 */
export function getAgentTelemetryWriterFirestore(): AdminFirestore {
  if (cachedWriterFirestore) {
    return cachedWriterFirestore;
  }

  const app = getOrCreateApp();
  cachedWriterFirestore = getAdminFirestore(app, AGENT_TELEMETRY_DATABASE_ID);

  const emulatorHost = getFirestoreEmulatorHost();
  if (isEmulator() && emulatorHost) {
    cachedWriterFirestore.settings({ host: emulatorHost, ssl: false });
  }

  return cachedWriterFirestore;
}

/** Upserts a session doc at `sessions/{sessionId}` in the telemetry database. */
export async function upsertSession(doc: SessionDoc): Promise<void> {
  const firestore = getAgentTelemetryWriterFirestore();
  await firestore
    .collection(SESSIONS_COLLECTION)
    .doc(doc.sessionId)
    .set(doc, { merge: true });
}

/**
 * Lists every session doc in the `agent-telemetry` database. Read-only by
 * design (the console's SA cannot write - see firestore-client.ts) and
 * unfiltered: callers narrow by `source`/`liveness` themselves, since the
 * collection is small (one doc per live-or-recent session, not per event).
 */
export async function listSessionDocs(
  firestore: Firestore,
): Promise<SessionDoc[]> {
  const snapshot = await firestore.collection(SESSIONS_COLLECTION).get();
  return snapshot.docs.map((doc) => doc.data() as SessionDoc);
}

/** @internal Reset cached clients for testing only. */
export function _resetForTesting(): void {
  cachedApp = null;
  cachedWriterFirestore = null;
}
