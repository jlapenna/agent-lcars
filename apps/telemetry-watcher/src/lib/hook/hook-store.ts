import {
  isNewerHookWrite,
  parseSessionDoc,
  type SessionDoc,
  type SessionEventV1,
  type SessionWrite,
  sessionWriteForEvent,
} from '@agent-lcars/telemetry';
import { FieldValue, Firestore, Timestamp } from '@google-cloud/firestore';

import { type HookWriterCredentials } from './hook-config';

/**
 * Applies hook events straight to the `sessions` collection as the
 * `telemetry-writer` service account (docs/hooks-telemetry-design.md §4.4),
 * the same identity `runner finalize` writes as. Each
 * event is one transaction: re-read the stored doc, refuse it if a newer
 * event from the same host already landed, otherwise merge the write.
 */
export type HookEventOutcome = 'applied' | 'stale' | 'invalid';

export interface HookEventWriter {
  apply(event: SessionEventV1, now: string): Promise<HookEventOutcome>;
}

const SESSIONS_COLLECTION = 'sessions';

/** gRPC status codes worth retrying: network, contention, quota, and auth
 *  (a rotated key is fixed by replacing the file, not by dropping events). */
const TRANSIENT_CODES = new Set([2, 4, 8, 10, 14, 16]);

/** Whether a Firestore failure may succeed later. Anything without a gRPC
 *  code (a network-level error) is treated as transient. */
export function isTransientFirestoreError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code !== 'number' || TRANSIENT_CODES.has(code);
}

export function hookEventPayload(write: SessionWrite): Record<string, unknown> {
  const { doc, clearFields } = write;
  return {
    ...doc,
    // A merged map must not retain an old identity after a contradictory
    // bridge observation, or old checkout credit after bounded overflow.
    deliverables: {
      ...doc.deliverables,
      claudeSessionId: doc.deliverables.claudeSessionId ?? FieldValue.delete(),
      publicationCheckouts:
        doc.deliverables.publicationCheckouts ?? FieldValue.delete(),
    },
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
    ...(options.credentialsFile && { keyFilename: options.credentialsFile }),
    ...(options.emulatorHost && { host: options.emulatorHost, ssl: false }),
  });
  return {
    apply(event, now) {
      const ref = firestore
        .collection(SESSIONS_COLLECTION)
        .doc(event.sessionId);
      return firestore
        .runTransaction(async (transaction) => {
          const snapshot = await transaction.get(ref);
          const stored = snapshot.exists ? snapshot.data() : undefined;
          let payload: Record<string, unknown>;
          let observer: SessionWrite['doc']['observer'];
          try {
            const write = sessionWriteForEvent(event, parseStored(stored), now);
            if (!write) return 'invalid' as const;
            observer = write.doc.observer;
            payload = hookEventPayload(write);
          } catch {
            // Deterministic: retrying this event can never succeed.
            return 'invalid' as const;
          }
          if (!isNewerHookWrite(stored?.['observer'], observer)) {
            return 'stale' as const;
          }
          transaction.set(ref, payload, { merge: true });
          return 'applied' as const;
        })
        .catch((error: unknown) => {
          if (isTransientFirestoreError(error)) throw error;
          return 'invalid' as const;
        });
    },
  };
}
