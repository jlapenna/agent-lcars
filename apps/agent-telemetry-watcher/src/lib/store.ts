import { Firestore, Timestamp } from '@google-cloud/firestore';
import { SessionDoc } from '@repo/agent-telemetry';
import { logger } from '@repo/logging';

const AGENT_TELEMETRY_DATABASE_ID = 'agent-telemetry';
const SESSIONS_COLLECTION = 'sessions';

export interface SessionStore {
  upsertSession(doc: SessionDoc): Promise<void>;
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
 * database (see apps/agent-console/infra/agent-telemetry.yaml) — never the
 * app's default database.
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
    async upsertSession(doc: SessionDoc): Promise<void> {
      // `expireAt` must be written as a native Firestore Timestamp (not the
      // ISO string SessionDoc carries it as) or the sessions TTL policy
      // (issue #2708/#2761) never sees it as eligible for deletion.
      await firestore
        .collection(SESSIONS_COLLECTION)
        .doc(doc.sessionId)
        .set(
          {
            ...doc,
            ...(doc.expireAt && {
              expireAt: Timestamp.fromDate(new Date(doc.expireAt)),
            }),
          },
          { merge: true },
        );
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
    async upsertSession(doc: SessionDoc): Promise<void> {
      logger.warn(
        `[log-only store] no writer credentials configured; would upsert sessions/${doc.sessionId}`,
        { doc },
      );
    },
  };
}
