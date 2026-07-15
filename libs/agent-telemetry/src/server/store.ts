import { Firestore, Timestamp } from '@google-cloud/firestore';
import {
  getFirestoreEmulatorHost,
  getProjectId,
  isEmulator,
} from '@repo/util-server';
import { App, getApps, initializeApp } from 'firebase-admin/app';
import {
  Firestore as AdminFirestore,
  getFirestore as getAdminFirestore,
  Timestamp as AdminTimestamp,
} from 'firebase-admin/firestore';

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

/**
 * Upserts a session doc at `sessions/{sessionId}` in the telemetry database.
 * `expireAt` is written as a Firestore `Timestamp` (not the ISO string
 * `SessionDoc` carries it as) because the collection's TTL policy — see
 * `tools/provision-agent-telemetry-gcp.sh` and issue #2708 — only recognizes
 * a native Timestamp field. Built via `AdminTimestamp` (the `firebase-admin`
 * re-export), not the plain `@google-cloud/firestore` `Timestamp` used
 * below for `listSessionDocs`: `getAgentTelemetryWriterFirestore` is a
 * `firebase-admin` client, and Next's bundler otherwise emits the two
 * `Timestamp` classes into separate chunks, so the SDK's `instanceof` check
 * on write fails with "not a valid Firestore document" (#2762).
 */
export async function upsertSession(doc: SessionDoc): Promise<void> {
  const firestore = getAgentTelemetryWriterFirestore();
  await firestore
    .collection(SESSIONS_COLLECTION)
    .doc(doc.sessionId)
    .set(
      {
        ...doc,
        ...(doc.expireAt && {
          expireAt: AdminTimestamp.fromDate(new Date(doc.expireAt)),
        }),
      },
      { merge: true },
    );
}

export interface ListSessionDocsOptions {
  /** Only return sessions with `lastActivityAt` at or after this ISO
   * timestamp. Without it the listing is unbounded - the collection grows
   * by one doc per session forever (200+ within the first weeks of
   * rollout) - so every recurring reader should pass a cutoff. */
  activeSince?: string;
}

/**
 * Lists session docs in the `agent-telemetry` database, newest activity
 * first. Read-only by design (the console's SA cannot write - see
 * firestore-client.ts); callers narrow by `source`/`liveness` themselves.
 */
export async function listSessionDocs(
  firestore: Firestore,
  options: ListSessionDocsOptions = {},
): Promise<SessionDoc[]> {
  const collection = firestore.collection(SESSIONS_COLLECTION);
  // ISO 8601 UTC timestamps compare correctly as strings, so a plain range
  // filter works without a Timestamp field or a composite index.
  const query = options.activeSince
    ? collection.where('lastActivityAt', '>=', options.activeSince)
    : collection;
  const snapshot = await query.get();
  const docs = snapshot.docs.map((doc) => {
    const data = doc.data();
    const expireAt = data['expireAt'];
    return {
      ...data,
      ...(expireAt instanceof Timestamp && {
        expireAt: expireAt.toDate().toISOString(),
      }),
    } as SessionDoc;
  });
  return docs.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/** @internal Reset cached clients for testing only. */
export function _resetForTesting(): void {
  cachedApp = null;
  cachedWriterFirestore = null;
}
