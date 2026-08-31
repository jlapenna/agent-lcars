import {
  type CollectionReference,
  type DocumentReference,
  FieldPath,
  FieldValue,
  Firestore,
} from '@google-cloud/firestore';
import { z } from 'zod';

import { type Decision, isRefusal, type Refusal } from './decide';
import {
  byOutboxClaimFairness,
  type GithubAnchorProjection,
  githubAnchorProjectionSchema,
  isLive,
  isWorkAnchor,
  type LeasedOutboxEntry,
  type OutboxEntry,
  outboxEntrySchema,
  parsePersistedRun,
  type RequestSource,
  type Run,
  runStateSchema,
  taskDocumentSchema,
  type TaskId,
  taskKey,
} from './model';
import {
  decodePersistedMigrationCursor,
  encodePersistedMigrationCursor,
  fingerprint,
  inventoryPersistedRecord,
  manifestId,
  PERSISTED_MIGRATION_PAGE_MAX,
  PersistedMigrationConflict,
  PersistedMigrationCursorError,
  type PersistedMigrationEntry,
  type PersistedMigrationPreview,
  type PersistedRecordKind,
  type PersistedRecordPage,
  type PersistedRecordSelector,
  validateManifest,
} from './persisted-record-migration';
import {
  mergeGithubAnchorSnapshot,
  type OrchestratorStore,
  type RequestTransactionState,
  StoreConflict,
  type TaskListCursor,
  type VersionedTask,
} from './store';

/** Live states, derived from the schema rather than re-listed by hand so it
 *  can never drift from `model.ts`'s own notion of "live". */
const LIVE_STATES = runStateSchema.options.filter(isLive);

const taskDocSchema = taskDocumentSchema;

/** The migration client decodes every Firestore integer as bigint. Current
 * schemas intentionally consume normal JavaScript numbers, so only values
 * whose exact value survives the conversion are normalized for shape
 * classification. Unsafe integers stay bigint and are reported as invalid;
 * their raw BigInt representation remains the stale-write fingerprint. */
function normalizeFirestoreIntegerValues(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value;
  }
  if (Array.isArray(value)) return value.map(normalizeFirestoreIntegerValues);
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        normalizeFirestoreIntegerValues(child),
      ]),
    );
  }
  return value;
}

export interface FirestoreStoreOptions {
  readonly projectId: string;
  readonly databaseId: string;
  /** Defaults to `orchestrator-`. Collections are `<prefix>tasks`,
   *  `<prefix>runs`, `<prefix>outbox`. */
  readonly collectionPrefix?: string;
  /** Set to talk to a local Firestore emulator instead of the real service. */
  readonly emulatorHost?: string;
}

/**
 * Firestore-backed `OrchestratorStore`. No caching, no cleverness: every
 * method is a direct read or write against the collections below, matching
 * `MemoryStore`'s observable behaviour.
 *
 * Document ids: `/` cannot appear in a Firestore document id, but
 * `taskKey()` and run/outbox ids all contain one (`repo#issue`,
 * `repo#issue/rN`, `dispatch/repo#issue/rN`, ...), so every id is
 * `encodeURIComponent`-ed before use as a document id, consistently on both
 * write and read.
 */
export class FirestoreStore implements OrchestratorStore {
  readonly #firestore: Firestore;
  /** Migration reads must preserve every Firestore int64 exactly. This stays
   * separate from the normal store client: ordinary Task/Run schemas use
   * JavaScript numbers and must not start receiving bigint values. */
  readonly #migrationFirestore: Firestore;
  readonly #tasks: CollectionReference;
  readonly #runs: CollectionReference;
  readonly #outbox: CollectionReference;
  readonly #migrationTasks: CollectionReference;
  readonly #migrationRuns: CollectionReference;
  readonly #migrationOutbox: CollectionReference;
  readonly #githubAnchors: CollectionReference;

  constructor(options: FirestoreStoreOptions) {
    const prefix = options.collectionPrefix ?? 'orchestrator-';
    const firestoreOptions = {
      projectId: options.projectId,
      databaseId: options.databaseId,
      ...(options.emulatorHost === undefined
        ? {}
        : { host: options.emulatorHost, ssl: false }),
    };
    this.#firestore = new Firestore(firestoreOptions);
    this.#migrationFirestore = new Firestore({
      ...firestoreOptions,
      useBigInt: true,
    });
    this.#tasks = this.#firestore.collection(`${prefix}tasks`);
    this.#runs = this.#firestore.collection(`${prefix}runs`);
    this.#outbox = this.#firestore.collection(`${prefix}outbox`);
    this.#migrationTasks = this.#migrationFirestore.collection(
      `${prefix}tasks`,
    );
    this.#migrationRuns = this.#migrationFirestore.collection(`${prefix}runs`);
    this.#migrationOutbox = this.#migrationFirestore.collection(
      `${prefix}outbox`,
    );
    this.#githubAnchors = this.#firestore.collection(`${prefix}github-anchors`);
  }

  async readTask(id: TaskId): Promise<VersionedTask | undefined> {
    const snapshot = await this.#taskRef(id).get();
    return snapshot.exists ? taskDocSchema.parse(snapshot.data()) : undefined;
  }

  async readRun(runId: string): Promise<Run | undefined> {
    const snapshot = await this.#runRef(runId).get();
    return snapshot.exists ? parsePersistedRun(snapshot.data()) : undefined;
  }

  async readActiveRun(id: TaskId): Promise<Run | undefined> {
    const task = await this.readTask(id);
    const activeRunId = task?.task.activeRunId;
    return activeRunId === undefined ? undefined : this.readRun(activeRunId);
  }

  async listRuns(id: TaskId): Promise<Run[]> {
    const snapshot = await this.#runsForTask(id).get();
    return snapshot.docs.map((doc) => parsePersistedRun(doc.data()));
  }

  async transactRequest(input: {
    taskId: TaskId;
    requestId: string;
    requestSource: RequestSource;
    decide(state: RequestTransactionState): Decision | Refusal;
  }): Promise<Decision | Refusal> {
    const taskRef = this.#taskRef(input.taskId);
    return this.#firestore.runTransaction(async (tx) => {
      // The exact-key history query and the task/run reads share this
      // transaction with the accepted write. Firestore reruns the callback
      // if any concurrent request or settlement changes one of those reads,
      // closing the terminal-settlement replay window as well as the live-run
      // race without scanning the task's unbounded run history.
      const taskSnapshot = await tx.get(taskRef);
      const task = taskSnapshot.exists
        ? taskDocSchema.parse(taskSnapshot.data())
        : undefined;
      const [activeRunSnapshot, runsSnapshot] = await Promise.all([
        task?.task.activeRunId === undefined
          ? Promise.resolve(undefined)
          : tx.get(this.#runRef(task.task.activeRunId)),
        tx.get(
          this.#runsForRequest(
            input.taskId,
            input.requestId,
            input.requestSource,
          ),
        ),
      ]);
      const activeRun =
        activeRunSnapshot === undefined || !activeRunSnapshot.exists
          ? undefined
          : parsePersistedRun(activeRunSnapshot.data());
      const previousRun = runsSnapshot.docs
        .map((doc) => parsePersistedRun(doc.data()))
        .find((run) => (run.requestSource ?? 'caller') === input.requestSource);
      const outcome = input.decide({ task, activeRun, previousRun });
      if (isRefusal(outcome)) return outcome;

      const nextTaskDoc: z.infer<typeof taskDocSchema> = {
        task: outcome.task,
        revision: (task?.revision ?? 0) + 1,
      };
      tx.set(taskRef, nextTaskDoc);
      if (outcome.run !== undefined) {
        tx.set(this.#runRef(outcome.run.runId), outcome.run);
      }
      for (const entry of outcome.outbox) {
        tx.set(this.#outboxRef(entry.entryId), entry);
      }
      return outcome;
    });
  }

  async apply(input: {
    decision: Decision;
    expectedRevision: number | undefined;
  }): Promise<void> {
    const { decision, expectedRevision } = input;
    const taskRef = this.#taskRef(decision.task.task);

    return this.#firestore.runTransaction(async (tx) => {
      // All reads before all writes, per Firestore transaction rules. Run/
      // outbox refs are computed below, after the read -- ref construction
      // isn't itself a read, so this still respects that ordering.
      const taskSnapshot = await tx.get(taskRef);
      const currentRevision = taskSnapshot.exists
        ? taskDocSchema.parse(taskSnapshot.data()).revision
        : undefined;
      if (currentRevision !== expectedRevision) {
        throw new StoreConflict(decision.task.task);
      }

      const nextTaskDoc: z.infer<typeof taskDocSchema> = {
        task: decision.task,
        revision: (expectedRevision ?? 0) + 1,
      };
      tx.set(taskRef, nextTaskDoc);

      if (decision.run !== undefined) {
        tx.set(this.#runRef(decision.run.runId), decision.run);
      }
      for (const entry of decision.outbox) {
        tx.set(this.#outboxRef(entry.entryId), entry);
      }
    });
  }

  async beginGithubAnchorProjectionRefresh(
    anchor: GithubAnchorProjection['anchor'],
  ): Promise<number> {
    const ref = this.#githubAnchorRef(anchor);
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const generation =
        typeof snapshot.data()?.['refreshGeneration'] === 'number'
          ? snapshot.data()?.['refreshGeneration'] + 1
          : 1;
      tx.set(ref, { refreshGeneration: generation }, { merge: true });
      return generation;
    });
  }

  async applyGithubAnchorProjectionRefresh(input: {
    anchor: GithubAnchorProjection['anchor'];
    generation: number;
    projection?: GithubAnchorProjection;
  }): Promise<boolean> {
    const ref = this.#githubAnchorRef(input.anchor);
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.data()?.['refreshGeneration'] !== input.generation) {
        return false;
      }
      if (input.projection === undefined) {
        tx.set(ref, { refreshGeneration: input.generation });
        return true;
      }
      const next = githubAnchorProjectionSchema.parse(input.projection);
      if (taskKey(next.anchor) !== taskKey(input.anchor)) {
        throw new Error(
          'GitHub anchor refresh projection does not match its fence',
        );
      }
      tx.set(ref, {
        projection: next,
        refreshGeneration: input.generation,
        ...(next.state === 'open'
          ? { openUpdatedAt: next.sourceUpdatedAt }
          : { openUpdatedAt: FieldValue.delete() }),
      });
      return true;
    });
  }

  async readGithubAnchorProjection(
    anchor: GithubAnchorProjection['anchor'],
  ): Promise<GithubAnchorProjection | undefined> {
    const snapshot = await this.#githubAnchorRef(anchor).get();
    const projection = snapshot.data()?.['projection'];
    return projection === undefined
      ? undefined
      : githubAnchorProjectionSchema.parse(projection);
  }

  async listOpenGithubAnchorProjections(
    limit = 200,
  ): Promise<GithubAnchorProjection[]> {
    // `openUpdatedAt` is present only on open anchors. Ordering this single
    // field is served by Firestore's automatic index and bounds the read at
    // the datastore without a state+order composite index.
    const snapshot = await this.#githubAnchors
      .orderBy('openUpdatedAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.flatMap((doc) => {
      const projection = githubAnchorProjectionSchema.parse(
        doc.data()['projection'],
      );
      // A pre-fence document may retain its old index field. Never present a
      // closed snapshot as an open queue item while the backfill refreshes it.
      return projection.state === 'open' ? [projection] : [];
    });
  }

  async claimPendingOutbox(input: {
    limit: number;
    now: string;
    leaseExpiresAt: string;
    excludeEntryIds?: ReadonlySet<string>;
  }): Promise<LeasedOutboxEntry[]> {
    if (input.limit <= 0) return [];

    return this.#firestore.runTransaction(async (tx) => {
      // Keep this index-free: both queries are single-field equality queries.
      // The leased population is bounded by active drains and the short
      // lease, so reading it to filter expiry client-side stays small.
      // Crucially, the query and every claim write share one transaction:
      // concurrent drains cannot both return ownership of the same document.
      const leasedSnapshot = await tx.get(
        this.#outbox.where('state', '==', 'leased'),
      );
      // No server-side `.limit()` on the pending query (#1548): the pending
      // population is exactly the backlog this store exists to drain, so
      // truncating it server-side before `excludeEntryIds` is applied would
      // silently favor whatever arbitrary subset Firestore's unordered
      // index scan happens to return first -- which is precisely how one
      // persistently-failing entry starved 145 of 162 pending entries for
      // six days without ever giving them a single claim attempt. Reading
      // the whole equality-filtered set and slicing client-side, after the
      // exclusion filter, is the same trade `listQueuedRuns` already makes
      // for the same reason (composite-index-free, and this population is
      // expected to stay small in steady state -- large only during exactly
      // the incident this fix targets, which drains it back down).
      const pendingSnapshot = await tx.get(
        this.#outbox.where('state', '==', 'pending'),
      );
      const cutoff = Date.parse(input.now);
      const expired = leasedSnapshot.docs.filter((doc) => {
        const entry = outboxEntrySchema.parse(doc.data());
        return (
          entry.state === 'leased' && Date.parse(entry.leaseExpiresAt) <= cutoff
        );
      });
      const excluded = input.excludeEntryIds;
      // #1548 follow-up: a pending entry still backing off from its last
      // delivery failure (`nextAttemptAt` in the future) is skipped here,
      // the same as an explicitly excluded one -- it never affects expired-
      // lease recovery above, since a lease can only be outstanding on an
      // entry that was itself already eligible to be claimed. See
      // `OrchestratorStore.claimPendingOutbox`'s doc comment. Sorted by
      // `byOutboxClaimFairness` (starvation fix) so a never-attempted entry
      // is never stuck behind an arbitrarily larger due-again,
      // already-failing set -- see that function's doc comment.
      const pendingCandidates = pendingSnapshot.docs
        .filter((doc) => {
          const entry = outboxEntrySchema.parse(doc.data());
          return (
            !(excluded?.has(entry.entryId) ?? false) &&
            (entry.nextAttemptAt === undefined ||
              Date.parse(entry.nextAttemptAt) <= cutoff)
          );
        })
        .sort((a, b) =>
          byOutboxClaimFairness(
            outboxEntrySchema.parse(a.data()),
            outboxEntrySchema.parse(b.data()),
          ),
        );
      const eligible = [...expired, ...pendingCandidates].slice(0, input.limit);

      return eligible.map((doc): LeasedOutboxEntry => {
        const entry = outboxEntrySchema.parse(doc.data());
        const { state: _state, ...rest } = entry;
        const claimed: LeasedOutboxEntry = {
          ...rest,
          state: 'leased',
          claimId: crypto.randomUUID(),
          leaseExpiresAt: input.leaseExpiresAt,
          attempts: entry.attempts + 1,
          updatedAt: input.now,
        };
        tx.set(doc.ref, claimed);
        return claimed;
      });
    });
  }

  async settleOutbox(input: {
    entryId: string;
    claimId: string;
    state: 'pending' | 'done' | 'failed';
    now: string;
    firstFailedAt?: string;
    nextAttemptAt?: string;
    deliveryFailures?: number;
  }): Promise<boolean> {
    const ref = this.#outboxRef(input.entryId);
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false; // no-op, matching MemoryStore
      const current = outboxEntrySchema.parse(snapshot.data());
      if (current.state !== 'leased' || current.claimId !== input.claimId) {
        return false;
      }
      const {
        claimId: _claimId,
        leaseExpiresAt: _leaseExpiresAt,
        ...rest
      } = current;
      const settled: OutboxEntry = {
        ...rest,
        state: input.state,
        updatedAt: input.now,
        // #1548 follow-up: omitted (`undefined`) leaves the field as
        // `rest` already carried it forward from `current` -- only a
        // caller settling an actual delivery failure passes these.
        ...(input.firstFailedAt === undefined
          ? {}
          : { firstFailedAt: input.firstFailedAt }),
        ...(input.nextAttemptAt === undefined
          ? {}
          : { nextAttemptAt: input.nextAttemptAt }),
        ...(input.deliveryFailures === undefined
          ? {}
          : { deliveryFailures: input.deliveryFailures }),
      };
      tx.set(ref, settled);
      return true;
    });
  }

  async listNativeTasks(
    limit?: number,
    before?: string,
  ): Promise<VersionedTask[]> {
    // The `orderBy` IS the filter. Firestore excludes any document that
    // lacks the ordered field entirely, and a GitHub-anchored task
    // document stores `task.task.repo`/`task.task.issue` with no
    // `workId` -- so ordering by `task.task.workId` returns exactly the
    // native anchors. Served by the automatic single-field index: no
    // composite index, and (crucially) no new persisted discriminator
    // field, which would have meant rewriting every existing task
    // document before this query could be trusted.
    //
    // `desc`: `workId` is a ULID, so lexicographic order on it is creation
    // order -- descending puts the newest task first, still served by that
    // same automatic single-field index (Firestore indexes both
    // directions), and `limit` bounds the read itself rather than reading
    // every native task ever created just to slice it down after.
    let query = this.#tasks.orderBy('task.task.workId', 'desc');
    // `startAfter` on a single orderBy'd field takes the field's value
    // directly (no document snapshot needed) and returns strictly older
    // entries than it in this same order -- exactly "the page after the
    // one that ended in `before`".
    if (before !== undefined) query = query.startAfter(before);
    const snapshot = await query.limit(limit ?? 200).get();
    return snapshot.docs.map((doc) => taskDocSchema.parse(doc.data()));
  }

  async listTasks(
    limit?: number,
    before?: TaskListCursor,
  ): Promise<VersionedTask[]> {
    // `updatedAt` makes this a useful live-console order rather than a
    // creation-order archive. Firestore's document id is the stable
    // tiebreaker, so concurrent decisions at the same timestamp page
    // without drops or repeats. `__name__` is the implicit final component
    // of Firestore's single-field index for an ordered field, so this does
    // not require an operator-managed composite index or a data migration.
    let query = this.#tasks
      .orderBy('task.updatedAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc');
    if (before !== undefined) {
      query = query.startAfter(
        before.updatedAt,
        encodeURIComponent(before.taskKey),
      );
    }
    const snapshot = await query.limit(limit ?? 200).get();
    return snapshot.docs.map((doc) => taskDocSchema.parse(doc.data()));
  }

  async listExpiredRuns(now: string): Promise<Run[]> {
    const cutoff = Date.parse(now);
    // A single query for `state in [...] AND leaseExpiresAt <= now` would
    // combine an equality/`in` filter with a range filter on a *different*
    // field, which Firestore only serves with a composite index. Rather
    // than require one, reuse the per-live-state equality queries
    // `listLiveRuns` already runs (each covered by Firestore's automatic
    // single-field index) and apply the lease-expiry filter client-side.
    return (await this.listLiveRuns()).filter(
      (run) => Date.parse(run.leaseExpiresAt) <= cutoff,
    );
  }

  async listLiveRuns(): Promise<Run[]> {
    // One single-field equality query per live state, merged -- see
    // `listExpiredRuns` above for why this shape rather than an `in` query
    // combined with a range filter.
    const perState = await Promise.all(
      LIVE_STATES.map((state) => this.#runs.where('state', '==', state).get()),
    );
    return perState.flatMap((snapshot) =>
      snapshot.docs.map((doc) => parsePersistedRun(doc.data())),
    );
  }

  async listRecentRuns(limit: number): Promise<Run[]> {
    // A global updatedAt order needs only Firestore's automatic single-field
    // index. Do not add a state filter here: filtering another field before
    // ordering would require a composite index and turn this bounded console
    // read into deployment configuration.
    const snapshot = await this.#runs
      .orderBy('updatedAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => parsePersistedRun(doc.data()));
  }

  async enqueueRun(input: { runId: string; now: string }): Promise<void> {
    const ref = this.#runRef(input.runId);
    await this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return;
      const run = parsePersistedRun(snapshot.data());
      if (run.queue !== undefined) return;
      tx.set(ref, {
        ...run,
        queue: { state: 'queued' },
        updatedAt: input.now,
      });
    });
  }

  async claimQueuedRun(input: {
    pipelines: readonly string[];
    now: string;
    claimedBy: string;
    tokenHash: string;
  }): Promise<Run | undefined> {
    return this.#firestore.runTransaction(async (tx) => {
      // One query per candidate pipeline, each a two-clause equality query
      // (`queue.state == 'queued' AND pipeline == p`) -- like `listRuns`'s
      // GitHub-anchor query, this is equality-only across both fields and
      // needs no composite index, so splitting by pipeline keeps every
      // query shape identical to a single-pipeline claim rather than
      // reaching for an `in` filter that would change that shape.
      const snapshots = await Promise.all(
        input.pipelines.map((pipeline) =>
          tx.get(
            this.#runs
              .where('queue.state', '==', 'queued')
              .where('pipeline', '==', pipeline),
          ),
        ),
      );
      const candidates = snapshots
        .flatMap((snapshot) => snapshot.docs)
        .map((doc) => ({ doc, run: parsePersistedRun(doc.data()) }))
        .sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt));
      const first = candidates[0];
      if (first === undefined) return undefined;
      const claimed: Run = {
        ...first.run,
        queue: {
          state: 'claimed',
          claimedAt: input.now,
          claimedBy: input.claimedBy,
          tokenHash: input.tokenHash,
        },
        updatedAt: input.now,
      };
      tx.set(first.doc.ref, claimed);
      return claimed;
    });
  }

  async listQueuedRuns(limit?: number): Promise<Run[]> {
    // Combining the `queue.state` equality filter with `orderBy('createdAt')`
    // (a different field) would need a composite index -- see
    // `listExpiredRuns`/`claimPendingOutbox` above for the same trade-off
    // elsewhere in this file. Instead, read every queued run through the
    // automatic single-field index and sort/bound client-side; the queued
    // population is expected to stay small by design (the queue exists for
    // fast pickup, not as a backlog), so reading it in full before slicing
    // is the same trade `claimPendingOutbox` already makes for its pending
    // population.
    const snapshot = await this.#runs
      .where('queue.state', '==', 'queued')
      .get();
    return snapshot.docs
      .map((doc) => parsePersistedRun(doc.data()))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit ?? 200);
  }

  async inventoryPersistedRecords(input: {
    kind: PersistedRecordKind;
    limit: number;
    cursor?: string;
  }): Promise<PersistedRecordPage> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > PERSISTED_MIGRATION_PAGE_MAX
    ) {
      throw new Error(
        `Persisted orchestrator inventory page size must be 1-${PERSISTED_MIGRATION_PAGE_MAX}`,
      );
    }
    const collection = this.#migrationCollectionFor(input.kind);
    let query = collection.orderBy(FieldPath.documentId());
    if (input.cursor !== undefined) {
      const documentId = decodePersistedMigrationCursor(
        input.cursor,
        input.kind,
      );
      // A well-formed cursor for another or nonexistent record must not
      // silently become a new first page. Verify it belongs to this fixed
      // collection before using it as a query boundary.
      if (!(await collection.doc(documentId).get()).exists) {
        throw new PersistedMigrationCursorError(
          'Invalid persisted orchestrator inventory cursor',
        );
      }
      query = query.startAfter(documentId);
    }
    // The extra document makes `hasMore` truthful at the exact page boundary
    // without scanning an unbounded collection.
    const snapshot = await query.limit(input.limit + 1).get();
    const documents = snapshot.docs.slice(0, input.limit);
    const hasMore = snapshot.docs.length > documents.length;
    return {
      kind: input.kind,
      consistency: 'page-only',
      records: documents.map((document) => {
        const raw = document.data();
        // Normalization is only for the current schema census. Raw values
        // remain BigInt-capable for the fingerprint used by the later
        // transaction, so an unsafe Firestore int64 can never collapse into
        // a rounded JavaScript number between inventory and apply.
        return {
          ...inventoryPersistedRecord(
            input.kind,
            normalizeFirestoreIntegerValues(raw),
          ),
          fingerprint: fingerprint(raw),
        };
      }),
      hasMore,
      ...(hasMore && documents.length > 0
        ? {
            nextCursor: encodePersistedMigrationCursor(
              input.kind,
              documents.at(-1)?.id ?? '',
            ),
          }
        : {}),
    };
  }

  async previewPersistedMigration(
    entries: readonly PersistedMigrationEntry[],
  ): Promise<PersistedMigrationPreview> {
    const validated = validateManifest(entries);
    return { manifestId: manifestId(validated), entries: validated.length };
  }

  async applyPersistedMigration(input: {
    entries: readonly PersistedMigrationEntry[];
    reviewedManifestId: string;
  }): Promise<PersistedMigrationPreview> {
    const entries = validateManifest(input.entries);
    const id = manifestId(entries);
    if (id !== input.reviewedManifestId) {
      throw new PersistedMigrationConflict(
        'reviewed manifest id does not match the submitted entries',
      );
    }
    await this.#migrationFirestore.runTransaction(async (tx) => {
      // Read every fixed manifest target first. Firestore retries the whole
      // transaction on a concurrent write; each retry compares the current
      // raw fingerprint before any write, so no reviewed replacement can
      // overwrite a record changed after the inventory.
      const snapshots = await Promise.all(
        entries.map((entry) => tx.get(this.#migrationRef(entry.selector))),
      );
      for (const [index, snapshot] of snapshots.entries()) {
        const entry = entries[index];
        if (entry === undefined) throw new Error('missing manifest entry');
        if (!snapshot.exists) {
          throw new PersistedMigrationConflict(
            `persisted ${entry.selector.kind} record disappeared`,
          );
        }
        if (fingerprint(snapshot.data()) !== entry.expectedFingerprint) {
          throw new PersistedMigrationConflict(
            `persisted ${entry.selector.kind} record changed after inventory`,
          );
        }
      }
      for (const entry of entries) {
        tx.set(this.#migrationRef(entry.selector), entry.replacement);
      }
    });
    return { manifestId: id, entries: entries.length };
  }

  #migrationCollectionFor(kind: PersistedRecordKind): CollectionReference {
    if (kind === 'task') return this.#migrationTasks;
    if (kind === 'run') return this.#migrationRuns;
    return this.#migrationOutbox;
  }

  #migrationRef(selector: PersistedRecordSelector): DocumentReference {
    if (selector.kind === 'task') {
      return this.#migrationTasks.doc(
        encodeURIComponent(taskKey(selector.task)),
      );
    }
    if (selector.kind === 'run') {
      return this.#migrationRuns.doc(encodeURIComponent(selector.runId));
    }
    return this.#migrationOutbox.doc(encodeURIComponent(selector.entryId));
  }

  #taskRef(id: TaskId): DocumentReference {
    return this.#tasks.doc(encodeURIComponent(taskKey(id)));
  }

  /** Equality-only query shape, shared by the public history read and the
   * request transaction so durable idempotency never needs a new index. */
  #runsForTask(id: TaskId) {
    return isWorkAnchor(id)
      ? this.#runs.where('task.workId', '==', id.workId)
      : this.#runs
          .where('task.repo', '==', id.repo)
          .where('task.issue', '==', id.issue);
  }

  /** A constant-size idempotency lookup. Automatic retries have an explicit
   * source field, so their query is exact. Caller history also includes
   * legacy runs without requestSource; at most one automatic-retry record can
   * share the raw ID, so two candidates are sufficient to find either caller
   * representation without an unbounded history scan. Equality-only filters
   * keep this on Firestore's automatic index merging path. */
  #runsForRequest(id: TaskId, requestId: string, source: RequestSource) {
    const query = this.#runsForTask(id).where('requestId', '==', requestId);
    return source === 'auto-retry'
      ? query.where('requestSource', '==', source).limit(1)
      : query.limit(2);
  }

  #runRef(runId: string): DocumentReference {
    return this.#runs.doc(encodeURIComponent(runId));
  }

  #outboxRef(entryId: string): DocumentReference {
    return this.#outbox.doc(encodeURIComponent(entryId));
  }

  #githubAnchorRef(
    anchor: GithubAnchorProjection['anchor'],
  ): DocumentReference {
    return this.#githubAnchors.doc(encodeURIComponent(taskKey(anchor)));
  }
}
