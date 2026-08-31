import { logger } from '@agent-lcars/logging';
import {
  isSafeIdentifier,
  type SessionSchemaBackfill,
  sessionSchemaBackfillPatch,
  type SessionWrite,
} from '@agent-lcars/telemetry';
import {
  FieldPath,
  FieldValue,
  Firestore,
  Timestamp,
} from '@google-cloud/firestore';

const AGENT_TELEMETRY_DATABASE_ID =
  process.env['AGENT_TELEMETRY_DATABASE_ID'] ?? '(default)';
const SESSIONS_COLLECTION = 'sessions';
export const MAX_SESSION_SCHEMA_MIGRATION_PAGE_SIZE = 200;

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
  inventory(input: {
    limit: number;
    cursor?: string;
  }): Promise<SessionSchemaMigrationInventoryPage>;
  get(sessionId: string): Promise<unknown | undefined>;
  /** Re-reads and validates within a Firestore transaction before patching,
   * so an operator can never overwrite a concurrent watcher update. */
  applySchemaBackfill(
    backfill: SessionSchemaBackfill,
  ): Promise<{ changed: boolean }>;
}

export interface SessionSchemaMigrationInventoryPage {
  records: { sessionId: string; data: unknown }[];
  hasMore: boolean;
  nextCursor?: string;
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
    async inventory({ limit, cursor }) {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_SESSION_SCHEMA_MIGRATION_PAGE_SIZE
      ) {
        throw new Error(
          `Session schema migration page size must be 1-${MAX_SESSION_SCHEMA_MIGRATION_PAGE_SIZE}`,
        );
      }
      let query = firestore
        .collection(SESSIONS_COLLECTION)
        .orderBy(FieldPath.documentId());
      if (cursor !== undefined) query = query.startAfter(cursor);
      // The document ID order covers records that lack newer timestamp
      // fields. Fetching one extra proves whether a bounded page has another
      // page, while the caller's explicit cursor walks every record.
      const snapshots = await query.limit(limit + 1).get();
      const documents = snapshots.docs.slice(0, limit);
      const hasMore = snapshots.docs.length > documents.length;
      return {
        records: documents.map((snapshot) => ({
          sessionId: snapshot.id,
          data: snapshot.data(),
        })),
        hasMore,
        ...(hasMore &&
          documents.length > 0 && {
            nextCursor: documents.at(-1)?.id,
          }),
      };
    },
    async get(sessionId) {
      assertSafeSessionId(sessionId);
      const snapshot = await firestore
        .collection(SESSIONS_COLLECTION)
        .doc(sessionId)
        .get();
      return snapshot.exists ? snapshot.data() : undefined;
    },
    async applySchemaBackfill(backfill) {
      assertSafeSessionId(backfill.sessionId);
      const reference = firestore
        .collection(SESSIONS_COLLECTION)
        .doc(backfill.sessionId);
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        if (!snapshot.exists) {
          throw new Error(`Session ${backfill.sessionId} was not found`);
        }
        // This validates the transaction's current snapshot, not a prior
        // dry-run read. A conflicting concurrent writer therefore aborts
        // rather than being overwritten by stale migration intent.
        const data = snapshot.data();
        if (data === undefined) {
          throw new Error(`Session ${backfill.sessionId} has no data`);
        }
        const patch = sessionSchemaBackfillPatch(data, backfill);
        const changed = Object.entries(patch).some(
          ([key, value]) => JSON.stringify(data[key]) !== JSON.stringify(value),
        );
        if (changed) transaction.set(reference, patch, { merge: true });
        return { changed };
      });
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
