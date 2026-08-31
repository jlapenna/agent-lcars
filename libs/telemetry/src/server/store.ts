import {
  getFirestoreEmulatorHost,
  getProjectId,
  isEmulator,
} from '@agent-lcars/util-server';
import { Firestore, Query, Timestamp } from '@google-cloud/firestore';
import { App, getApps, initializeApp } from 'firebase-admin/app';
import {
  FieldValue as AdminFieldValue,
  Firestore as AdminFirestore,
  getFirestore as getAdminFirestore,
  Timestamp as AdminTimestamp,
} from 'firebase-admin/firestore';

import { parseSessionDoc } from '../lib/session-doc';
import { SessionDoc, SessionSource, SessionWrite } from '../lib/types';
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
 * `AGENT_TELEMETRY_WRITER_KEY_JSON` key file for host watchers (see
 * infra/terraform/main.tf's `telemetry_writer` resources) — never a
 * credential hardcoded in this module. Distinct from
 * `getAgentTelemetryReaderFirestore` in firestore-client.ts, which runs as
 * the console's own runtime identity read-only and cannot use to write.
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
 * Upserts a session write at `sessions/{sessionId}` in the telemetry
 * database. `expireAt` is written as a Firestore `Timestamp` (not the ISO
 * string `SessionDoc` carries it as) because the collection's TTL policy —
 * see issue #2708 — only recognizes a native Timestamp field. Built via
 * `AdminTimestamp` (the `firebase-admin`
 * re-export), not the plain `@google-cloud/firestore` `Timestamp` used
 * below for `listSessionDocs`: `getAgentTelemetryWriterFirestore` is a
 * `firebase-admin` client, and Next's bundler otherwise emits the two
 * `Timestamp` classes into separate chunks, so the SDK's `instanceof` check
 * on write fails with "not a valid Firestore document" (#2762). The exact
 * same reasoning is why `write.clearFields` is mapped to `AdminFieldValue
 * .delete()` (the `firebase-admin` re-export) rather than
 * `@google-cloud/firestore`'s own `FieldValue` (issue #1257) — mixing the
 * two SDKs' sentinel classes on a `firebase-admin` client risks the same
 * cross-chunk `instanceof` failure #2762 already hit for `Timestamp`.
 *
 * Takes a {@link SessionWrite}, never a bare `SessionDoc` plus extra
 * arguments — see that type's doc comment in `types.ts` for why a caller
 * cannot describe a write this value doesn't already carry.
 */
export async function upsertSession(write: SessionWrite): Promise<void> {
  const { doc, clearFields } = write;
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
        ...Object.fromEntries(
          clearFields.map((field) => [field, AdminFieldValue.delete()]),
        ),
      },
      { merge: true },
    );
}

/**
 * Rewrites only `expireAt` on an existing session doc -- the
 * watermark-only write the session-pin reaper needs (sub-project 6), as
 * opposed to `upsertSession`'s full reduce-then-merge write. Same
 * Timestamp conversion `upsertSession` already applies to the same field,
 * for the same reason: the collection's native Firestore TTL policy only
 * recognizes a Timestamp, not the ISO string `SessionDoc` carries it as --
 * see `upsertSession`'s own doc comment for why it must be `AdminTimestamp`
 * (the `firebase-admin` re-export) rather than `@google-cloud/firestore`'s
 * own `Timestamp`.
 *
 * This is an UNCONDITIONAL overwrite, not a clamp/max -- it never reads the
 * doc's current `expireAt` before writing, so a caller that ever passed an
 * earlier date would shrink the horizon, not extend it. "Extend-only" is
 * true in practice only because every caller today (the session-pin
 * reaper) computes `expireAt` as `now + ISSUE_AGENT_SESSION_RETENTION_DAYS`
 * with `lastActivityAt <= now`, so the computed value is always at or
 * after whatever a real activity write would already have set. A future
 * caller with a different horizon or a backdated `now` would silently
 * break that invariant -- this function itself does not enforce it.
 */
export async function touchSessionExpiry(
  sessionId: string,
  expireAt: string,
): Promise<void> {
  const firestore = getAgentTelemetryWriterFirestore();
  // `.set(..., { merge: true })`, not `.update(...)`: if the session doc
  // were TTL-deleted by Firestore between the reaper's read (the items API
  // call that produced this sessionId) and this write, `.update` would
  // throw NOT_FOUND while `.set(..., { merge: true })` silently resurrects
  // a field-less ghost document carrying only `expireAt`. Deliberate --
  // see sub-project 6's design tradeoffs; do not change this to `.update`.
  await firestore
    .collection(SESSIONS_COLLECTION)
    .doc(sessionId)
    .set(
      { expireAt: AdminTimestamp.fromDate(new Date(expireAt)) },
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
   * range+equality compound query, requiring a source+lastActivityAt
   * composite index on `sessions`. */
  source?: SessionSource;
  /** Narrows to one issue-agent session's issue. Combined with
   * `activeSince` this is also a compound query - see the
   * issueNumber+lastActivityAt (and source+issueNumber+lastActivityAt)
   * composite indexes alongside the `source` ones. */
  issueNumber?: number;
  /** Narrows to the sessions of one orchestrator run
   * (`IssueAgentSessionDoc.intentId` -- the join key from a native work
   * item's run to its telemetry). Equality-only, so it composes with
   * `source` without a composite index; add `activeSince` and it becomes a
   * compound query needing an intentId+lastActivityAt index, which is why
   * the work API's session join deliberately passes no cutoff -- a run's
   * session set is bounded by the run itself. */
  intentId?: string;
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
  // issueNumber/intentId are plain equality filters; composing any of them
  // with the range filter needs the composite indexes documented above.
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
  if (options.intentId !== undefined) {
    query = query.where('intentId', '==', options.intentId);
  }
  const snapshot = await query.get();
  const docs = snapshot.docs.map((doc) => {
    const data = doc.data();
    const expireAt = data['expireAt'];
    return parseSessionDoc({
      ...data,
      ...(expireAt instanceof Timestamp && {
        expireAt: expireAt.toDate().toISOString(),
      }),
    });
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
  return parseSessionDoc({
    ...data,
    ...(expireAt instanceof Timestamp && {
      expireAt: expireAt.toDate().toISOString(),
    }),
  });
}

/** @internal Reset cached clients for testing only. */
export function _resetForTesting(): void {
  cachedApp = null;
  cachedWriterFirestore = null;
}
