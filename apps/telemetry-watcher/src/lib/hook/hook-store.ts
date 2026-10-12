import {
  isNewerHookWrite,
  parseSessionDoc,
  type SessionDoc,
  type SessionEventV1,
  type SessionWrite,
  sessionWriteForEvent,
} from '@agent-lcars/telemetry';
import { FieldValue, Firestore, Timestamp } from '@google-cloud/firestore';

/**
 * Applies hook events straight to the `sessions` collection as the
 * `telemetry-writer` service account (docs/hooks-telemetry-design.md §4.4),
 * the same identity the watcher daemon and runner sidecars write as. Each
 * event is one transaction: re-read the stored doc, refuse it if a newer
 * event from the same host already landed, otherwise merge the write.
 */
export type HookEventOutcome = 'applied' | 'stale' | 'invalid';

export interface HookEventWriter {
  apply(event: SessionEventV1, now: string): Promise<HookEventOutcome>;
}

export interface HookWriterCredentials {
  readonly projectId: string;
  /** Service-account key; absent means Application Default Credentials. */
  readonly credentials?: { client_email: string; private_key: string };
  readonly emulatorHost?: string;
}

const SESSIONS_COLLECTION = 'sessions';

function payloadFor(write: SessionWrite): Record<string, unknown> {
  const { doc, clearFields } = write;
  return {
    ...doc,
    ...(doc.expireAt && {
      expireAt: Timestamp.fromDate(new Date(doc.expireAt)),
    }),
    ...Object.fromEntries(
      clearFields.map((field) => [field, FieldValue.delete()]),
    ),
  };
}

function parseStored(data: unknown): SessionDoc | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const record = { ...(data as Record<string, unknown>) };
  // Firestore hands TTL fields back as Timestamps; the doc contract is ISO.
  const expireAt = record['expireAt'];
  if (expireAt instanceof Timestamp) {
    record['expireAt'] = expireAt.toDate().toISOString();
  }
  try {
    return parseSessionDoc(record);
  } catch {
    return undefined;
  }
}

export function createHookEventWriter(
  options: HookWriterCredentials,
  databaseId = process.env['AGENT_TELEMETRY_DATABASE_ID'] ?? '(default)',
): HookEventWriter {
  const firestore = new Firestore({
    projectId: options.projectId,
    databaseId,
    ...(options.credentials && { credentials: options.credentials }),
    ...(options.emulatorHost && { host: options.emulatorHost, ssl: false }),
  });
  return {
    apply(event, now) {
      const ref = firestore
        .collection(SESSIONS_COLLECTION)
        .doc(event.sessionId);
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const stored = snapshot.exists ? snapshot.data() : undefined;
        const existing = parseStored(stored);
        const write = sessionWriteForEvent(event, existing, now);
        if (!write) return 'invalid';
        if (!isNewerHookWrite(stored?.['observer'], write.doc.observer)) {
          return 'stale';
        }
        transaction.set(ref, payloadFor(write), { merge: true });
        return 'applied';
      });
    },
  };
}
