import { logger } from '@agent-lcars/logging';
import { isSafeIdentifier, SessionWrite } from '@agent-lcars/telemetry';
import { FieldValue, Firestore, Timestamp } from '@google-cloud/firestore';

const AGENT_TELEMETRY_DATABASE_ID =
  process.env['AGENT_TELEMETRY_DATABASE_ID'] ?? '(default)';
const SESSIONS_COLLECTION = 'sessions';

function assertSafeSessionId(sessionId: string): void {
  if (!isSafeIdentifier(sessionId)) {
    throw new Error('Session schema migration requires a safe session ID');
  }
}

export interface SessionStore {
  /** Takes a {@link SessionWrite}, never a bare doc plus extra arguments —
   * see that type's doc comment (`@agent-lcars/telemetry`'s `types.ts`) for
   * why a caller cannot describe a write this value doesn't already carry. */
  upsertSession(write: SessionWrite): Promise<void>;
}

/** Narrow operator-only boundary for the one-time current-session schema
 * migration. It exposes no caller-selected collection, query, or document
 * access: inventory is bounded and writes are fixed metadata patches on an
 * explicitly named `sessions/{sessionId}` document. */
export interface SessionSchemaMigrationStore {
  inventory(limit: number): Promise<{ sessionId: string; data: unknown }[]>;
  get(sessionId: string): Promise<unknown | undefined>;
  patchSchema(
    sessionId: string,
    patch: {
      agent: string;
      repo: { owner: string; name: string };
      renderable?: boolean;
    },
  ): Promise<void>;
}

export interface FirestoreStoreOptions {
  projectId: string;
  /** Parsed contents of the `AGENT_TELEMETRY_WRITER_KEY_JSON` secret. */
  credentials?: { client_email: string; private_key: string };
  /** Overrides the emulator host normally read from `FIRESTORE_EMULATOR_HOST`. */
  emulatorHost?: string;
}

/**
 * Writer-scoped Firestore client for the dedicated `agent-telemetry`
 * database (see infra/terraform/main.tf) — never the app's default
 * database.
 */
export function createFirestoreStore(
  options: FirestoreStoreOptions,
): SessionStore {
  const firestore = new Firestore({
    projectId: options.projectId,
    databaseId: AGENT_TELEMETRY_DATABASE_ID,
    ...(options.credentials && { credentials: options.credentials }),
    ...(options.emulatorHost && {
      host: options.emulatorHost,
      ssl: false,
    }),
  });

  return {
    async upsertSession(write: SessionWrite): Promise<void> {
      const { doc, clearFields } = write;
      // `expireAt` must be written as a native Firestore Timestamp (not the
      // ISO string SessionDoc carries it as) or the sessions TTL policy
      // (issue #2708/#2761) never sees it as eligible for deletion.
      //
      // `clearFields` (issue #1257) maps to this SDK's own `FieldValue
      // .delete()` — not `firebase-admin/firestore`'s re-export, which
      // `libs/telemetry/src/server/store.ts` uses instead for the same
      // reason that module's own comment explains for `Timestamp`: mixing
      // the two SDKs' sentinel classes on one client risks a cross-chunk
      // `instanceof` failure (#2762). This module is a plain
      // `@google-cloud/firestore` client, so it stays on that package's own
      // `FieldValue` throughout.
      await firestore
        .collection(SESSIONS_COLLECTION)
        .doc(doc.sessionId)
        .set(
          {
            ...doc,
            ...(doc.expireAt && {
              expireAt: Timestamp.fromDate(new Date(doc.expireAt)),
            }),
            ...Object.fromEntries(
              clearFields.map((field) => [field, FieldValue.delete()]),
            ),
          },
          { merge: true },
        );
    },
  };
}

export function createSessionSchemaMigrationStore(
  options: FirestoreStoreOptions,
): SessionSchemaMigrationStore {
  const firestore = new Firestore({
    projectId: options.projectId,
    databaseId: AGENT_TELEMETRY_DATABASE_ID,
    ...(options.credentials && { credentials: options.credentials }),
    ...(options.emulatorHost && { host: options.emulatorHost, ssl: false }),
  });
  return {
    async inventory(limit) {
      const snapshots = await firestore
        .collection(SESSIONS_COLLECTION)
        .orderBy('lastActivityAt', 'desc')
        .limit(limit)
        .get();
      return snapshots.docs.map((snapshot) => ({
        sessionId: snapshot.id,
        data: snapshot.data(),
      }));
    },
    async get(sessionId) {
      assertSafeSessionId(sessionId);
      const snapshot = await firestore
        .collection(SESSIONS_COLLECTION)
        .doc(sessionId)
        .get();
      return snapshot.exists ? snapshot.data() : undefined;
    },
    async patchSchema(sessionId, patch) {
      assertSafeSessionId(sessionId);
      await firestore
        .collection(SESSIONS_COLLECTION)
        .doc(sessionId)
        .set(patch, { merge: true });
    },
  };
}

/**
 * Fallback store used when no writer credentials are configured (e.g. a
 * local `docker run` smoke test with no GCP access). Logs what it would
 * have written instead of failing the daemon outright — consistent with
 * the "fails soft" posture required everywhere else in the watcher.
 */
export function createLogOnlyStore(): SessionStore {
  return {
    async upsertSession(write: SessionWrite): Promise<void> {
      logger.warn(
        `[log-only store] no writer credentials configured; would upsert sessions/${write.doc.sessionId}`,
        { write },
      );
    },
  };
}
