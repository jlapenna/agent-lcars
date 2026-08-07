/**
 * Firestore-backed `StoragePort`, implemented directly against Firestore's
 * REST API (`node:` builtins and global `fetch` only -- see "Why REST, not
 * the client library" below). Proves itself the same way `./firestore-port.ts`
 * does: by passing `./port.contract.ts`'s suite unmodified against a real
 * Firestore emulator (`./firestore-rest-port.spec.ts`), never a mock -- CAS
 * correctness under real contention is exactly the property a mock cannot
 * prove.
 *
 * `main.ts` imports this class as of #645 Phase 6 (shadow mode) --
 * `createShadowStoragePort` there is the one place it is constructed, and
 * only when `DISPATCH_STORAGE_MODE` is `'shadow'` (see `./shadow.ts`'s
 * header for the inertness argument). That is observation only: the
 * comment ledger stays sole authority, and this class is never consulted
 * to decide anything about a live dispatch, only written to and diffed
 * against afterward. Still deliberately NOT imported from `canary/run.ts`
 * or `rerun-infra-killed-runs/main.ts` -- neither has a shadow-mode
 * observation step of its own -- and `./firestore-port.ts` (the client-
 * library adapter) stays unimported everywhere in the live dispatch path
 * for the bundle-size reason its own header gives.
 *
 * ## Why REST, not the client library
 *
 * `./firestore-port.ts` (the `@google-cloud/firestore`-backed adapter) is
 * correct but unusable from the broker: bundling that client measures at
 * 4.3 MB, and the broker ships as a *committed* dependency-free esbuild
 * bundle -- currently ~101 KB -- regenerated and drift-diffed by CI on every
 * source change (apps/dispatch-broker/project.json's `build`/`build-canary`/
 * `build-rerun-infra-killed-runs` targets; .github/workflows/ci.yml's drift
 * check). Committing a 4.3 MB artifact that churns on every edit is not
 * acceptable. The broker already talks to GitHub over plain REST with
 * `fetch`; Firestore has a REST API too. This file is that path: zero
 * third-party dependencies, `node:` builtins and global `fetch` only. If a
 * change to this file ever needs a package, the design has failed -- stop
 * and report rather than adding one.
 *
 * ## Collection layout
 *
 * Identical to `./firestore-port.ts` (see that file's header for the fuller
 * rationale) -- verified against it directly, not just described here, so
 * the two adapters can read each other's data:
 *
 *   - `dispatchTasks` -- one document per `StoredTask`, keyed by
 *     `taskKey(task)` (./port.ts).
 *   - `dispatchLaunchOutbox` -- one document per `LaunchOutboxOperation`,
 *     keyed by `operation.operationId`.
 *
 * Every field is plain JSON -- no Firestore `timestampValue`/`geoPointValue`/
 * `referenceValue`. All date fields are stored as `stringValue` (ISO-8601),
 * matching `port.ts`'s declared `string` type for every date field and
 * `firestore-port.ts`'s same choice, so a round-tripped read is structurally
 * identical to what was written and the two adapters stay interchangeable.
 *
 * ## How compare-and-swap is genuinely atomic
 *
 * Firestore's REST `:commit` endpoint accepts a `currentDocument`
 * precondition per write that the server evaluates atomically at commit
 * time, before applying the write: `{ exists: false }` for "this document
 * must not exist yet" (a create), or `{ updateTime: <t> }` for "this
 * document's last-modified time must still be exactly `<t>`" (an
 * update/CAS). `writeTask` maps `expectedRevision` onto this directly:
 *
 *   1. Read the document once (`GET`), which yields both the app-level
 *      `revision` field and Firestore's own server-tracked `updateTime`.
 *   2. If the read `revision` does not equal `expectedRevision`, throw
 *      `TaskWriteConflictError` immediately -- no write attempted. This
 *      covers the single-caller cases (write a duplicate revision, write a
 *      never-created task with a defined expected revision) without a
 *      wasted round trip.
 *   3. Otherwise `:commit` the new document body with
 *      `currentDocument: { exists: false }` (no prior document observed) or
 *      `currentDocument: { updateTime: <the updateTime read in step 1> }`
 *      (a prior document observed at that exact server-tracked moment).
 *
 * For two writers racing from the same starting revision, both perform step
 * 1 independently and observe the same `updateTime` before either commits.
 * Only ONE `:commit` can ever land on a document whose `updateTime` still
 * equals what was read: the instant the first writer's commit lands, the
 * document's real `updateTime` changes, so the second writer's precondition
 * necessarily no longer matches, and Firestore rejects that commit outright
 * (`FAILED_PRECONDITION`/`ALREADY_EXISTS`, never applying its write) rather
 * than either serializing behind the winner or silently overwriting it. This
 * was verified directly against a real emulator while building this file,
 * not assumed: two concurrent `:commit` calls carrying the same precondition
 * `updateTime`, fired truly in parallel (not sequentially), produced exactly
 * one HTTP 200 and one HTTP 400 `FAILED_PRECONDITION` naming the stale base
 * version, with the document left holding only the winner's write. A losing
 * writer cannot succeed here for the same reason it cannot with
 * `firestore-port.ts`'s transactions: the one and only place either
 * writer's fate is decided is Firestore's own commit evaluation, which is
 * atomic per document by construction -- not a lock this file takes,
 * retries, or could get wrong by racing itself. On a lost race the loser
 * re-reads (one more `GET`, outside the decision itself) purely to report
 * an accurate `actualRevision` in the thrown error; the conflict was already
 * final before that re-read happens.
 *
 * The same precondition-on-`:commit` pattern is used for
 * `recordLaunchIntent` (`exists: false`) and `resolveLaunchOutcome`
 * (`updateTime` from the pending read) for the same reason
 * `firestore-port.ts` gives: a read-then-write with no precondition would
 * still be a real race for two concurrent callers reusing the same
 * `operationId`, even though `port.contract.ts` only exercises their
 * idempotence sequentially, not under contention.
 *
 * ## Auth
 *
 * Takes a bearer token, or a callback that returns one, as constructor
 * input (`FirestoreRestStoragePortOptions.token`) -- this file never
 * resolves credentials itself. In production that token comes from
 * `google-github-actions/auth`; in tests it is the Firestore emulator's
 * `owner` literal. A callback (rather than a fixed string) lets a caller
 * holding a short-lived token refresh it between calls without
 * constructing a new port.
 *
 * `emulatorHost` mirrors `firestore-port.ts`'s option of the same name:
 * pass it explicitly, or leave it unset to fall back to the ambient
 * `FIRESTORE_EMULATOR_HOST` env var -- read directly here, since there is
 * no client library to do that lookup for us. Either way, only the base URL
 * changes; the request shapes are identical against production Firestore
 * and the emulator.
 */

import { isDeepStrictEqual } from 'node:util';

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
 *  two in-process values only (one just deserialized from a Firestore REST
 *  read), never a wire/hash format, so key insertion order must not affect
 *  the result. */
function sameResolution(
  a: LaunchOutboxResolution,
  b: LaunchOutboxResolution,
): boolean {
  return isDeepStrictEqual(a, b);
}

// ---------------------------------------------------------------------------
// Firestore REST <-> plain-JSON value marshalling.
// ---------------------------------------------------------------------------

type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

function toFirestoreValue(value: unknown): FirestoreValue {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        // Defensive, not load-bearing for anything port.contract.ts
        // exercises today: no domain field here is ever an array
        // containing `undefined`, but skipping it (rather than crashing on
        // it) matches the same "absent, not null" posture `toFirestoreFields`
        // takes for object keys below.
        values: value
          .filter((element) => element !== undefined)
          .map(toFirestoreValue),
      },
    };
  }
  if (typeof value === 'object') {
    return {
      mapValue: {
        fields: toFirestoreFields(value as Record<string, unknown>),
      },
    };
  }
  throw new TypeError(
    `Cannot store a value of type ${typeof value} in Firestore`,
  );
}

/** Drops `undefined`-valued keys -- the same "absent, not null" semantics
 *  `firestore-port.ts` gets for free from `ignoreUndefinedProperties: true`.
 *  This file has no client library option to lean on, so it filters
 *  explicitly, at every nesting level (via `toFirestoreValue`'s own object
 *  branch calling back into this function). */
function toFirestoreFields(
  obj: Record<string, unknown>,
): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    fields[key] = toFirestoreValue(value);
  }
  return fields;
}

function fromFirestoreValue(value: FirestoreValue): unknown {
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) {
    return (value.arrayValue.values ?? []).map(fromFirestoreValue);
  }
  if ('mapValue' in value) {
    return fromFirestoreFields(value.mapValue.fields ?? {});
  }
  throw new TypeError(`Unrecognized Firestore value: ${JSON.stringify(value)}`);
}

function fromFirestoreFields(
  fields: Record<string, FirestoreValue>,
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    obj[key] = fromFirestoreValue(value);
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Low-level REST plumbing.
// ---------------------------------------------------------------------------

/** Thrown for any Firestore REST response this file does not otherwise
 *  interpret as a domain-level outcome (e.g. auth failure, malformed
 *  request, emulator unreachable) -- distinct from `TaskWriteConflictError`,
 *  which is reserved for the one conflict `StoragePort` itself defines. */
class FirestoreRestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      `Firestore REST request failed with HTTP ${status}: ${JSON.stringify(body)}`,
    );
    this.name = 'FirestoreRestError';
  }
}

/** Only ever `{ exists: false }` (a create) or `{ updateTime }` (a CAS
 *  update) here -- this file never needs "must exist, any revision", so the
 *  type is intentionally narrower than the full REST precondition shape. */
type Precondition = { exists: false } | { updateTime: string };

export interface FirestoreRestStoragePortOptions {
  projectId: string;
  /** Bearer token for the `Authorization` header, or a callback that
   *  returns one -- invoked fresh on every request, so a caller holding a
   *  short-lived token (e.g. from `google-github-actions/auth`) can refresh
   *  it without constructing a new port. This file never resolves
   *  credentials itself; see the module header's "Auth" section. */
  token: string | (() => string | Promise<string>);
  /** Overrides the emulator host normally read from `FIRESTORE_EMULATOR_HOST`. */
  emulatorHost?: string;
}

/**
 * Firestore-backed `StoragePort`, talking to Firestore's REST API directly
 * with `fetch`. See the module header for the collection layout and the
 * atomicity argument -- this class is intentionally thin; the correctness
 * case lives in the doc comment above, not spread across the methods below.
 */
export class FirestoreRestStoragePort implements StoragePort {
  #token: string | (() => string | Promise<string>);
  #documentsRoot: string;
  #baseUrl: string;

  constructor(options: FirestoreRestStoragePortOptions) {
    this.#token = options.token;
    this.#documentsRoot = `projects/${options.projectId}/databases/(default)/documents`;
    const emulatorHost =
      options.emulatorHost ?? process.env.FIRESTORE_EMULATOR_HOST;
    this.#baseUrl = emulatorHost
      ? `http://${emulatorHost}/v1/${this.#documentsRoot}`
      : `https://firestore.googleapis.com/v1/${this.#documentsRoot}`;
  }

  async #authHeader(): Promise<string> {
    const token =
      typeof this.#token === 'function' ? await this.#token() : this.#token;
    return `Bearer ${token}`;
  }

  async #request(
    url: string,
    init?: { method?: string; body?: unknown },
  ): Promise<{ status: number; body: unknown }> {
    const requestInit: RequestInit = {
      method: init?.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await this.#authHeader(),
      },
    };
    if (init?.body !== undefined) {
      requestInit.body = JSON.stringify(init.body);
    }
    const response = await fetch(url, requestInit);
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
    };
  }

  #documentUrl(collection: string, id: string): string {
    return `${this.#baseUrl}/${collection}/${encodeURIComponent(id)}`;
  }

  #documentName(collection: string, id: string): string {
    return `${this.#documentsRoot}/${collection}/${id}`;
  }

  /** `GET` one document. `undefined` when it does not exist -- the REST API
   *  reports that as HTTP 404 `NOT_FOUND`, verified directly against the
   *  emulator rather than assumed. */
  async #getDocument(
    collection: string,
    id: string,
  ): Promise<
    { fields: Record<string, FirestoreValue>; updateTime: string } | undefined
  > {
    const { status, body } = await this.#request(
      this.#documentUrl(collection, id),
    );
    if (status === 404) return undefined;
    if (status !== 200) throw new FirestoreRestError(status, body);
    const document = body as {
      fields?: Record<string, FirestoreValue>;
      updateTime: string;
    };
    return { fields: document.fields ?? {}, updateTime: document.updateTime };
  }

  /**
   * `:commit` one document write under a `currentDocument` precondition.
   * Returns `false` -- never throws -- when the precondition was not met
   * (`ALREADY_EXISTS` for a failed `exists: false`, `FAILED_PRECONDITION`
   * for a stale `updateTime`), both verified directly against the emulator.
   * Any other non-2xx response is a genuine, unexpected failure and throws
   * `FirestoreRestError`.
   */
  async #commit(
    collection: string,
    id: string,
    fields: Record<string, FirestoreValue>,
    currentDocument: Precondition,
  ): Promise<boolean> {
    const { status, body } = await this.#request(`${this.#baseUrl}:commit`, {
      method: 'POST',
      body: {
        writes: [
          {
            update: { name: this.#documentName(collection, id), fields },
            currentDocument,
          },
        ],
      },
    });
    if (status === 200) return true;
    const errorStatus = (body as { error?: { status?: string } } | undefined)
      ?.error?.status;
    if (
      (status === 409 && errorStatus === 'ALREADY_EXISTS') ||
      (status === 400 && errorStatus === 'FAILED_PRECONDITION')
    ) {
      return false;
    }
    throw new FirestoreRestError(status, body);
  }

  // -------------------------------------------------------------------------
  // Task aggregate.
  // -------------------------------------------------------------------------

  async readTask(task: TaskRef): Promise<StoredTask | undefined> {
    const document = await this.#getDocument(TASKS_COLLECTION, taskKey(task));
    return document
      ? (fromFirestoreFields(document.fields) as unknown as StoredTask)
      : undefined;
  }

  async writeTask(
    task: TaskRef,
    expectedRevision: number | undefined,
    next: StoredTaskInput,
    now: string = defaultNow(),
  ): Promise<StoredTask> {
    const id = taskKey(task);
    const current = await this.#getDocument(TASKS_COLLECTION, id);
    const currentRevision = current
      ? (fromFirestoreFields(current.fields) as unknown as StoredTask).revision
      : undefined;
    if (currentRevision !== expectedRevision) {
      throw new TaskWriteConflictError(task, expectedRevision, currentRevision);
    }

    const stored: StoredTask = {
      ...structuredClone(next),
      task: structuredClone(task),
      revision: (expectedRevision ?? 0) + 1,
      updatedAt: now,
    };
    const precondition: Precondition = current
      ? { updateTime: current.updateTime }
      : { exists: false };

    const committed = await this.#commit(
      TASKS_COLLECTION,
      id,
      toFirestoreFields(stored as unknown as Record<string, unknown>),
      precondition,
    );
    if (!committed) {
      // Firestore's server-evaluated precondition already decided this
      // writer lost -- see the module header's atomicity argument. This
      // re-read exists only to report an accurate actualRevision in the
      // error; it plays no role in the conflict decision itself.
      const latest = await this.#getDocument(TASKS_COLLECTION, id);
      const latestRevision = latest
        ? (fromFirestoreFields(latest.fields) as unknown as StoredTask).revision
        : undefined;
      throw new TaskWriteConflictError(task, expectedRevision, latestRevision);
    }
    return stored;
  }

  // -------------------------------------------------------------------------
  // Launch outbox.
  // -------------------------------------------------------------------------

  async recordLaunchIntent(
    operation: { operationId: string; task: TaskRef; attemptId: string },
    now: string = defaultNow(),
  ): Promise<LaunchOutboxOperation> {
    const document = await this.#getDocument(
      LAUNCH_OUTBOX_COLLECTION,
      operation.operationId,
    );
    if (document) {
      const existing = fromFirestoreFields(
        document.fields,
      ) as unknown as LaunchOutboxOperation;
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
    const committed = await this.#commit(
      LAUNCH_OUTBOX_COLLECTION,
      operation.operationId,
      toFirestoreFields(created as unknown as Record<string, unknown>),
      { exists: false },
    );
    if (!committed) {
      // Someone else recorded this operationId between our read and our
      // create attempt -- re-apply the same idempotence/conflict rules
      // against whatever is actually stored now.
      return this.recordLaunchIntent(operation, now);
    }
    return created;
  }

  async resolveLaunchOutcome(
    operationId: string,
    resolution: LaunchOutboxResolution,
    now: string = defaultNow(),
  ): Promise<LaunchOutboxOperation> {
    const document = await this.#getDocument(
      LAUNCH_OUTBOX_COLLECTION,
      operationId,
    );
    if (!document) {
      throw new Error(
        `Cannot resolve launch outbox operation that was never recorded: ${operationId}`,
      );
    }
    const existing = fromFirestoreFields(
      document.fields,
    ) as unknown as LaunchOutboxOperation;
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
    const committed = await this.#commit(
      LAUNCH_OUTBOX_COLLECTION,
      operationId,
      toFirestoreFields(resolved as unknown as Record<string, unknown>),
      { updateTime: document.updateTime },
    );
    if (!committed) {
      // Lost a race with a concurrent resolver -- re-apply the same
      // idempotence/conflict rules against whatever actually landed.
      return this.resolveLaunchOutcome(operationId, resolution, now);
    }
    return resolved;
  }

  async readLaunchOperation(
    operationId: string,
  ): Promise<LaunchOutboxOperation | undefined> {
    const document = await this.#getDocument(
      LAUNCH_OUTBOX_COLLECTION,
      operationId,
    );
    return document
      ? (fromFirestoreFields(
          document.fields,
        ) as unknown as LaunchOutboxOperation)
      : undefined;
  }

  async listPendingLaunchOperations(): Promise<LaunchOutboxOperation[]> {
    const { status, body } = await this.#request(`${this.#baseUrl}:runQuery`, {
      method: 'POST',
      body: {
        structuredQuery: {
          from: [{ collectionId: LAUNCH_OUTBOX_COLLECTION }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'status' },
              op: 'EQUAL',
              value: { stringValue: 'pending' },
            },
          },
        },
      },
    });
    if (status !== 200) throw new FirestoreRestError(status, body);
    const rows = body as Array<{
      document?: { fields?: Record<string, FirestoreValue> };
    }>;
    return rows
      .filter((row) => row.document !== undefined)
      .map(
        (row) =>
          fromFirestoreFields(
            row.document?.fields ?? {},
          ) as unknown as LaunchOutboxOperation,
      );
  }
}
