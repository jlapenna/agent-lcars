/**
 * Firestore-backed `RecoveryOperationPort`, using the same client library
 * and the same collection-per-database placement as `./firestore-port.ts`
 * (see that file's header for the credential-resolution and "why the client
 * library, not REST" rationale -- this module runs inside `apps/console`'s
 * App Hosting server, which has no committed-bundle-size constraint, so it
 * imports `@google-cloud/firestore` directly rather than reimplementing REST
 * marshalling).
 *
 * ## Collection
 *
 * One new collection, `recoveryOperations`, in the SAME database
 * `./firestore-port.ts` already writes `dispatchTasks`/
 * `dispatchLaunchOutbox` to (`DISPATCH_FIRESTORE_DATABASE_ID`) -- not a new
 * database. Firestore collections are schemaless and created implicitly on
 * first write, and the writer identity that already holds
 * `roles/datastore.user` for this database (see the finding recorded in
 * agent-lcars#731: that role is project-wide, not per-database) can write
 * a new collection here with no IAM/Terraform change. Deliberately reusing
 * existing infrastructure rather than provisioning anything new, per this
 * repository's guardrail that Terraform/new-database changes need their
 * own separate explicit approval.
 *
 * Document ID is NOT `operationKey` directly -- that key's fixed
 * `recovery/v1:` prefix contains a `/`, which Firestore treats as a path
 * separator and rejects in a document ID. `docId` SHA-256-hashes the key
 * instead of encoding it reversibly: `RecoveryOperationTarget.exactIdentity`
 * has no declared upper bound, and a merely long (not malicious) one pushed
 * through a reversible base64url encoding can exceed Firestore's 1,500-byte
 * document ID limit, turning a well-formed observation into a hard failure
 * on write. A fixed-length digest is collision-resistant regardless of input
 * length and never needs decoding -- the real `operationKey` is stored as a
 * plain field so a console operator reading the collection directly does
 * not have to decode anything to recognize a record.
 *
 * ## Atomicity
 *
 * Same transactional shape as `./firestore-port.ts`'s
 * `recordLaunchIntent`/`resolveLaunchOutcome`: one `runTransaction` per
 * call, `tx.get()` then `tx.set()`, never a bare read-then-write. See that
 * file's header for the full argument for why this is genuinely atomic
 * under concurrent callers, which applies unchanged here.
 */

import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { RecoveryObservation } from '@agent-lcars/dispatch-contracts';
import { type CollectionReference, Firestore } from '@google-cloud/firestore';

import {
  type RecordedRecoveryOperation,
  RecoveryOperationAlreadyResolvedError,
  RecoveryOperationNotRecordedError,
  type RecoveryOperationPort,
  type RecoveryOperationStatus,
} from './recovery-port';

const RECOVERY_OPERATIONS_COLLECTION = 'recoveryOperations';

function defaultNow(): string {
  return new Date().toISOString();
}

/** Same rationale as `./firestore-port.ts`'s `sameResolution`: compares two
 *  in-process values, never a wire/hash format. */
function sameDetail(a: string | undefined, b: string | undefined): boolean {
  return isDeepStrictEqual(a, b);
}

/** Firestore document IDs cannot contain `/` (path separator), have other
 *  reserved-character restrictions, and are capped at 1,500 bytes.
 *  `exactIdentity` has no declared upper bound (see the module header), so a
 *  reversible encoding of the whole key could exceed that cap for an
 *  otherwise well-formed observation. A SHA-256 digest is a pure function of
 *  the key (same key always maps to the same document), fixed at 43
 *  base64url characters regardless of input length, and collision-resistant
 *  enough that this port does not need to handle a collision as a real
 *  case. */
function docId(operationKey: string): string {
  return crypto
    .createHash('sha256')
    .update(operationKey, 'utf8')
    .digest('base64url');
}

export interface FirestoreRecoveryOperationPortOptions {
  projectId: string;
  /** Same database `./firestore-port.ts` writes controller state to -- see
   *  the module header for why this is not a new database. */
  databaseId: string;
  credentials?: { client_email: string; private_key: string };
  emulatorHost?: string;
}

export class FirestoreRecoveryOperationPort implements RecoveryOperationPort {
  #firestore: Firestore;
  #operations: CollectionReference;

  constructor(options: FirestoreRecoveryOperationPortOptions) {
    this.#firestore = new Firestore({
      projectId: options.projectId,
      databaseId: options.databaseId,
      ignoreUndefinedProperties: true,
      ...(options.credentials ? { credentials: options.credentials } : {}),
      ...(options.emulatorHost
        ? { host: options.emulatorHost, ssl: false }
        : {}),
    });
    this.#operations = this.#firestore.collection(
      RECOVERY_OPERATIONS_COLLECTION,
    );
  }

  async recordObservation(
    observation: RecoveryObservation,
    now: string = defaultNow(),
  ): Promise<RecordedRecoveryOperation> {
    const docRef = this.#operations.doc(docId(observation.operationKey));
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(docRef);
      if (snapshot.exists) {
        // First-observation-wins: see in-memory-port.ts's identical comment.
        return snapshot.data() as RecordedRecoveryOperation;
      }
      const created: RecordedRecoveryOperation = {
        operationKey: observation.operationKey,
        observation: structuredClone(observation),
        recordedAt: now,
        status: 'pending',
      };
      tx.set(docRef, created);
      return created;
    });
  }

  async resolveRecoveryOperation(
    operationKey: string,
    status: Exclude<RecoveryOperationStatus, 'pending'>,
    detail?: string,
    now: string = defaultNow(),
  ): Promise<RecordedRecoveryOperation> {
    const docRef = this.#operations.doc(docId(operationKey));
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(docRef);
      if (!snapshot.exists) {
        throw new RecoveryOperationNotRecordedError(operationKey);
      }
      const existing = snapshot.data() as RecordedRecoveryOperation;
      if (existing.status !== 'pending') {
        const same =
          existing.status === status && sameDetail(existing.detail, detail);
        if (same) return existing;
        throw new RecoveryOperationAlreadyResolvedError(
          operationKey,
          existing.status,
        );
      }
      const resolved: RecordedRecoveryOperation = {
        ...existing,
        status,
        resolvedAt: now,
        ...(detail === undefined ? {} : { detail }),
      };
      tx.set(docRef, resolved);
      return resolved;
    });
  }

  async readRecoveryOperation(
    operationKey: string,
  ): Promise<RecordedRecoveryOperation | undefined> {
    const snapshot = await this.#operations.doc(docId(operationKey)).get();
    return snapshot.exists
      ? (snapshot.data() as RecordedRecoveryOperation)
      : undefined;
  }

  async listPendingRecoveryOperations(): Promise<RecordedRecoveryOperation[]> {
    const snapshot = await this.#operations
      .where('status', '==', 'pending')
      .get();
    return snapshot.docs.map((doc) => doc.data() as RecordedRecoveryOperation);
  }
}
