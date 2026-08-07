/**
 * Firestore-backed `StoragePort` (#645 Phase 5's "durable backend later" ->
 * Phase 6's actual blocker). Proves itself the same way any backend must:
 * by passing `./port.contract.ts`'s suite unmodified (see
 * `./firestore-port.spec.ts`, which runs that suite against a real
 * Firestore emulator, not a mock -- CAS correctness is exactly the property
 * a mock cannot prove).
 *
 * This module is deliberately NOT imported from `main.ts`, `canary/run.ts`,
 * or `rerun-infra-killed-runs/main.ts` -- per port.ts's header, wiring a
 * durable backend into the live dispatch path is Phase 6 work this task
 * does not do. Keeping the only reference to `@google-cloud/firestore` in a
 * module those three entry points never import is what keeps that
 * (comparatively heavy) client out of their bundles; see the `build`,
 * `build-canary`, and `build-rerun-infra-killed-runs` targets in
 * apps/dispatch-broker/project.json; and the drift check in
 * .github/workflows/ci.yml that diffs the committed bundles against a fresh
 * rebuild. Do not add an import of this file to any of those three entry
 * points without first checking what that does to their bundle size.
 *
 * ## Collection layout
 *
 * Two top-level collections in the project's default Firestore database
 * (no dedicated database like `agent-telemetry`'s -- provisioning one is a
 * Terraform change, out of this task's scope; see infra/terraform/main.tf
 * for how `agent-telemetry` itself was provisioned, as the template a
 * future dedicated-database migration would follow):
 *
 *   - `dispatchTasks` -- one document per `StoredTask`. Document ID is
 *     `taskKey(task)` (./port.ts), i.e. `${repositoryId}:${issue}` --
 *     stable and derived, never random, so `writeTask`/`readTask` for the
 *     same task always address the same document regardless of process.
 *     The document body is the `StoredTask` shape verbatim (`task`,
 *     `revision`, `updatedAt`, `desiredIntentId?`, `signals[]`,
 *     `intents[]`), all plain JSON -- no Firestore `Timestamp`/`GeoPoint`/
 *     reference values, because `port.ts` declares every date field as a
 *     plain ISO-8601 `string`, and storing anything else would make a
 *     round-tripped read structurally different from what was written.
 *
 *   - `dispatchLaunchOutbox` -- one document per `LaunchOutboxOperation`.
 *     Document ID is `operation.operationId` directly -- already the
 *     port's own idempotency key (port.ts: "Callers should use the
 *     attemptId itself"), so reusing it as the document ID is what makes
 *     `recordLaunchIntent`'s idempotence a plain keyed lookup rather than a
 *     query.
 *
 * Indexed fields: only `status` on `dispatchLaunchOutbox`, for
 * `listPendingLaunchOperations`'s `where('status', '==', 'pending')` --  a
 * single-field equality filter, which Firestore indexes automatically for
 * every field by default. No composite index (no `firestore.indexes.json`
 * entry) is needed anywhere in this file.
 *
 * ## How compare-and-swap is genuinely atomic
 *
 * `writeTask` reads the current revision and performs its write inside one
 * `firestore.runTransaction()` call -- never a separate read followed by an
 * unconditional write. Firestore transactions hold a pessimistic lock on
 * every document a transaction reads, and the client library automatically
 * retries the whole `updateFunction` (re-running the read) up to five times
 * if a transaction is aborted by contention on commit. Concretely, for two
 * writers racing from the same starting revision: whichever transaction
 * commits first wins outright; the other either blocks on the lock until
 * the winner releases it (then its own `tx.get()` observes the *new*
 * revision) or has its commit aborted and is retried by the client library
 * (same result -- its retry's `tx.get()` observes the new revision). Either
 * way, the loser's `expectedRevision` -- a value fixed by its caller before
 * either writer started, never re-read -- no longer matches what
 * `tx.get()` returns, so it throws `TaskWriteConflictError` and `tx.set()`
 * is never reached. Nothing here polls, retries at this module's own level,
 * or resolves a conflict by last-write-wins; the one and only place either
 * writer's fate is decided is Firestore's own transaction commit. The same
 * transactional pattern is used for `recordLaunchIntent` and
 * `resolveLaunchOutcome`, even though `port.contract.ts` only exercises
 * their idempotence sequentially (not under a race) -- a read-then-write
 * without a transaction would still be a real race for two concurrent
 * callers reusing the same `operationId`, so there is no reason to build
 * two different reliability postures into one file.
 *
 * ## Credential resolution
 *
 * Mirrors `apps/telemetry-watcher/src/lib/store.ts`'s `createFirestoreStore`
 * (search "create-store.ts" there for the fuller rationale this file does
 * not repeat): `projectId` is required, `credentials` is an optional parsed
 * service-account key, and `emulatorHost` overrides the client's default
 * `FIRESTORE_EMULATOR_HOST` env lookup so tests do not depend on ambient
 * env state. Omitting both `credentials` and `emulatorHost` falls back to
 * `@google-cloud/firestore`'s own Application Default Credentials
 * resolution, unchanged.
 */

import { isDeepStrictEqual } from 'node:util';

import { type CollectionReference, Firestore } from '@google-cloud/firestore';

import {
  type LaunchOutboxOperation,
  type LaunchOutboxResolution,
  type StoragePort,
  type StoredTask,
  type StoredTaskInput,
  taskKey,
  type TaskRef,
  TaskWriteConflictError,
} from './port.js';

const TASKS_COLLECTION = 'dispatchTasks';
const LAUNCH_OUTBOX_COLLECTION = 'dispatchLaunchOutbox';

function defaultNow(): string {
  return new Date().toISOString();
}

/** Same rationale as `in-memory-port.ts`'s `sameResolution`: this compares
 *  two in-process values (one just deserialized from a Firestore read),
 *  never a wire/hash format, so key insertion order must not affect the
 *  result -- `isDeepStrictEqual` gives exactly that. */
function sameResolution(
  a: LaunchOutboxResolution,
  b: LaunchOutboxResolution,
): boolean {
  return isDeepStrictEqual(a, b);
}

export interface FirestoreStoragePortOptions {
  projectId: string;
  /** Parsed contents of a Firestore writer service-account key. Omit to
   *  fall back to ambient Application Default Credentials -- see the
   *  module header's "Credential resolution" section. */
  credentials?: { client_email: string; private_key: string };
  /** Overrides the emulator host normally read from `FIRESTORE_EMULATOR_HOST`
   *  by the underlying client. */
  emulatorHost?: string;
}

/**
 * Firestore-backed `StoragePort` implementation. See the module header for
 * the collection layout and the atomicity argument -- this class is
 * intentionally thin; the correctness case lives in the doc comment above,
 * not spread across the methods below.
 */
export class FirestoreStoragePort implements StoragePort {
  #firestore: Firestore;
  #tasks: CollectionReference;
  #outbox: CollectionReference;

  constructor(options: FirestoreStoragePortOptions) {
    this.#firestore = new Firestore({
      projectId: options.projectId,
      // Every field this port stores is plain JSON with optional properties
      // (e.g. `StoredTask.desiredIntentId?`, several `AttemptRecord`
      // fields) that a caller may legitimately construct via an object
      // spread that leaves the key present with value `undefined` rather
      // than omitted. Firestore rejects `undefined` field values by default;
      // this makes it drop them instead, at every nesting level, which is
      // the same "absent, not null" semantics `StoredTaskInput`'s optional
      // fields already document.
      ignoreUndefinedProperties: true,
      ...(options.credentials && { credentials: options.credentials }),
      ...(options.emulatorHost && {
        host: options.emulatorHost,
        ssl: false,
      }),
    });
    this.#tasks = this.#firestore.collection(TASKS_COLLECTION);
    this.#outbox = this.#firestore.collection(LAUNCH_OUTBOX_COLLECTION);
  }

  async readTask(task: TaskRef): Promise<StoredTask | undefined> {
    const snapshot = await this.#tasks.doc(taskKey(task)).get();
    return snapshot.exists ? (snapshot.data() as StoredTask) : undefined;
  }

  async writeTask(
    task: TaskRef,
    expectedRevision: number | undefined,
    next: StoredTaskInput,
    now: string = defaultNow(),
  ): Promise<StoredTask> {
    const docRef = this.#tasks.doc(taskKey(task));
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(docRef);
      const currentRevision = snapshot.exists
        ? (snapshot.data() as StoredTask).revision
        : undefined;
      if (currentRevision !== expectedRevision) {
        throw new TaskWriteConflictError(
          task,
          expectedRevision,
          currentRevision,
        );
      }
      const stored: StoredTask = {
        ...structuredClone(next),
        task: structuredClone(task),
        revision: (expectedRevision ?? 0) + 1,
        updatedAt: now,
      };
      tx.set(docRef, stored);
      return stored;
    });
  }

  async recordLaunchIntent(
    operation: { operationId: string; task: TaskRef; attemptId: string },
    now: string = defaultNow(),
  ): Promise<LaunchOutboxOperation> {
    const docRef = this.#outbox.doc(operation.operationId);
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(docRef);
      if (snapshot.exists) {
        const existing = snapshot.data() as LaunchOutboxOperation;
        const sameOperation =
          existing.attemptId === operation.attemptId &&
          taskKey(existing.task) === taskKey(operation.task);
        if (!sameOperation) {
          throw new Error(
            `Launch outbox operation ID reused for a different attempt: ${operation.operationId}`,
          );
        }
        // At-least-once record: see in-memory-port.ts's identical comment.
        return existing;
      }
      const created: LaunchOutboxOperation = {
        operationId: operation.operationId,
        task: structuredClone(operation.task),
        attemptId: operation.attemptId,
        recordedAt: now,
        status: 'pending',
      };
      tx.set(docRef, created);
      return created;
    });
  }

  async resolveLaunchOutcome(
    operationId: string,
    resolution: LaunchOutboxResolution,
    now: string = defaultNow(),
  ): Promise<LaunchOutboxOperation> {
    const docRef = this.#outbox.doc(operationId);
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(docRef);
      if (!snapshot.exists) {
        throw new Error(
          `Cannot resolve launch outbox operation that was never recorded: ${operationId}`,
        );
      }
      const existing = snapshot.data() as LaunchOutboxOperation;
      if (existing.status !== 'pending') {
        if (
          existing.resolution &&
          sameResolution(existing.resolution, resolution)
        ) {
          return existing;
        }
        throw new Error(
          `Launch outbox operation ${operationId} already resolved as ` +
            `${existing.status}; refusing to overwrite with a different resolution`,
        );
      }
      const resolved: LaunchOutboxOperation = {
        ...existing,
        status: resolution.status,
        resolvedAt: now,
        resolution,
      };
      tx.set(docRef, resolved);
      return resolved;
    });
  }

  async readLaunchOperation(
    operationId: string,
  ): Promise<LaunchOutboxOperation | undefined> {
    const snapshot = await this.#outbox.doc(operationId).get();
    return snapshot.exists
      ? (snapshot.data() as LaunchOutboxOperation)
      : undefined;
  }

  async listPendingLaunchOperations(): Promise<LaunchOutboxOperation[]> {
    const snapshot = await this.#outbox.where('status', '==', 'pending').get();
    return snapshot.docs.map((doc) => doc.data() as LaunchOutboxOperation);
  }
}
