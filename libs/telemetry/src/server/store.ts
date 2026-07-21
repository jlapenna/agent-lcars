import { Firestore, Query, Timestamp } from '@google-cloud/firestore';
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

import { SessionDoc, SessionSource } from '../lib/types';
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
 * infra-inventory/agent-telemetry.yaml) — never a credential
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

/** Default page size for `listSessionDocs` when the caller doesn't ask for a
 * specific `limit` - generous enough for the dashboard's 24h window, small
 * enough to keep the archive page's default 14-day window cheap. */
const DEFAULT_LIST_LIMIT = 100;
/** Hard ceiling on `limit`, regardless of what a caller (ultimately a
 * client-controlled query param on the /sessions archive page) requests -
 * this is a read-only reader path with no auth boundary of its own beyond
 * the console's admin gate, so the cap is enforced here rather than trusted
 * to every caller. */
const MAX_LIST_LIMIT = 200;

export interface ListSessionDocsOptions {
  /** Only return sessions with `lastActivityAt` at or after this ISO
   * timestamp. Without it the listing is unbounded - the collection grows
   * by one doc per session forever (200+ within the first weeks of
   * rollout) - so every recurring reader should pass a cutoff. */
  activeSince?: string;
  /** Narrows to one source. Combined with `activeSince` this is a
   * range+equality compound query - see the composite indexes provisioned
   * for `sessions` in infra-inventory/agent-telemetry.yaml's
   * firestore.indexes section (source+lastActivityAt). */
  source?: SessionSource;
  /** Narrows to one issue-agent session's issue. Combined with
   * `activeSince` this is also a compound query - see the
   * issueNumber+lastActivityAt (and source+issueNumber+lastActivityAt)
   * composite indexes alongside the `source` ones. */
  issueNumber?: number;
  /** Caps the number of docs returned (post-sort, newest activity first).
   * Clamped to [1, {@link MAX_LIST_LIMIT}]; defaults to
   * {@link DEFAULT_LIST_LIMIT} when omitted. */
  limit?: number;
}

/**
 * Lists session docs in the `agent-telemetry` database, newest activity
 * first. Read-only by design (the console's SA cannot write - see
 * firestore-client.ts); callers narrow by `liveness` themselves (not a
 * stored/queryable field in the sense that matters here - see
 * `displayLiveness`, which recomputes it at read time).
 */
export async function listSessionDocs(
  firestore: Firestore,
  options: ListSessionDocsOptions = {},
): Promise<SessionDoc[]> {
  const collection = firestore.collection(SESSIONS_COLLECTION);
  // ISO 8601 UTC timestamps compare correctly as strings, so the
  // activeSince range filter works without a Timestamp field. source/
  // issueNumber are plain equality filters; composing any of them with the
  // range filter needs the composite indexes documented above.
  let query: Query = collection;
  if (options.activeSince) {
    query = query.where('lastActivityAt', '>=', options.activeSince);
  }
  if (options.source) {
    query = query.where('source', '==', options.source);
  }
  if (options.issueNumber !== undefined) {
    query = query.where('issueNumber', '==', options.issueNumber);
  }
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
  const sorted = docs.sort((a, b) =>
    b.lastActivityAt.localeCompare(a.lastActivityAt),
  );
  const limit = Math.min(
    Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT),
    MAX_LIST_LIMIT,
  );
  return sorted.slice(0, limit);
}

/**
 * Fetches a single session doc by id, or `undefined` if it doesn't exist
 * (never throws for a missing doc - only for a real Firestore failure, left
 * to the caller). Powers the /sessions/[id] detail page.
 */
export async function getSessionDoc(
  firestore: Firestore,
  sessionId: string,
): Promise<SessionDoc | undefined> {
  const snapshot = await firestore
    .collection(SESSIONS_COLLECTION)
    .doc(sessionId)
    .get();
  if (!snapshot.exists) {
    return undefined;
  }
  const data = snapshot.data();
  if (!data) {
    return undefined;
  }
  const expireAt = data['expireAt'];
  return {
    ...data,
    ...(expireAt instanceof Timestamp && {
      expireAt: expireAt.toDate().toISOString(),
    }),
  } as SessionDoc;
}

/** @internal Reset cached clients for testing only. */
export function _resetForTesting(): void {
  cachedApp = null;
  cachedWriterFirestore = null;
}
