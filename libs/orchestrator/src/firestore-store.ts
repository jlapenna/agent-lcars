import {
  type CollectionReference,
  type DocumentReference,
  Firestore,
} from '@google-cloud/firestore';
import { z } from 'zod';

import type { Decision } from './decide';
import {
  isLive,
  isWorkAnchor,
  type LeasedOutboxEntry,
  type OutboxEntry,
  outboxEntrySchema,
  type Run,
  runSchema,
  runStateSchema,
  type TaskId,
  taskKey,
  taskSchema,
} from './model';
import {
  type OrchestratorStore,
  StoreConflict,
  type VersionedTask,
} from './store';

/** Live states, derived from the schema rather than re-listed by hand so it
 *  can never drift from `model.ts`'s own notion of "live". */
const LIVE_STATES = runStateSchema.options.filter(isLive);

const taskDocSchema = z.strictObject({
  task: taskSchema,
  revision: z.number().int().nonnegative(),
});

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
  readonly #tasks: CollectionReference;
  readonly #runs: CollectionReference;
  readonly #outbox: CollectionReference;

  constructor(options: FirestoreStoreOptions) {
    const prefix = options.collectionPrefix ?? 'orchestrator-';
    this.#firestore = new Firestore({
      projectId: options.projectId,
      databaseId: options.databaseId,
      ...(options.emulatorHost === undefined
        ? {}
        : { host: options.emulatorHost, ssl: false }),
    });
    this.#tasks = this.#firestore.collection(`${prefix}tasks`);
    this.#runs = this.#firestore.collection(`${prefix}runs`);
    this.#outbox = this.#firestore.collection(`${prefix}outbox`);
  }

  async readTask(id: TaskId): Promise<VersionedTask | undefined> {
    const snapshot = await this.#taskRef(id).get();
    return snapshot.exists ? taskDocSchema.parse(snapshot.data()) : undefined;
  }

  async readRun(runId: string): Promise<Run | undefined> {
    const snapshot = await this.#runRef(runId).get();
    return snapshot.exists ? runSchema.parse(snapshot.data()) : undefined;
  }

  async readActiveRun(id: TaskId): Promise<Run | undefined> {
    const task = await this.readTask(id);
    const activeRunId = task?.task.activeRunId;
    return activeRunId === undefined ? undefined : this.readRun(activeRunId);
  }

  async listRuns(id: TaskId): Promise<Run[]> {
    // Equality-only filters on single fields: served from Firestore's
    // automatic indexes without a composite index, for either anchor.
    const query = isWorkAnchor(id)
      ? this.#runs.where('task.workId', '==', id.workId)
      : this.#runs
          .where('task.repo', '==', id.repo)
          .where('task.issue', '==', id.issue);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => runSchema.parse(doc.data()));
  }

  async apply(input: {
    decision: Decision;
    expectedRevision: number | undefined;
  }): Promise<void> {
    const { decision, expectedRevision } = input;
    const taskRef = this.#taskRef(decision.task.task);

    await this.#firestore.runTransaction(async (tx) => {
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

  async claimPendingOutbox(input: {
    limit: number;
    now: string;
    leaseExpiresAt: string;
  }): Promise<LeasedOutboxEntry[]> {
    if (input.limit <= 0) return [];

    return this.#firestore.runTransaction(async (tx) => {
      // Keep this index-free: both queries are single-field equality queries.
      // The leased population is bounded by active drains and the short lease,
      // so reading it to filter expiry client-side stays small. Crucially, the
      // query and every claim write share one transaction: concurrent drains
      // cannot both return ownership of the same document.
      const leasedSnapshot = await tx.get(
        this.#outbox.where('state', '==', 'leased'),
      );
      const pendingSnapshot = await tx.get(
        this.#outbox.where('state', '==', 'pending').limit(input.limit),
      );
      const cutoff = Date.parse(input.now);
      const expired = leasedSnapshot.docs.filter((doc) => {
        const entry = outboxEntrySchema.parse(doc.data());
        return (
          entry.state === 'leased' && Date.parse(entry.leaseExpiresAt) <= cutoff
        );
      });
      const eligible = [...expired, ...pendingSnapshot.docs].slice(
        0,
        input.limit,
      );

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
    state: 'pending' | 'done';
    now: string;
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
      };
      tx.set(ref, settled);
      return true;
    });
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
      snapshot.docs.map((doc) => runSchema.parse(doc.data())),
    );
  }

  #taskRef(id: TaskId): DocumentReference {
    return this.#tasks.doc(encodeURIComponent(taskKey(id)));
  }

  #runRef(runId: string): DocumentReference {
    return this.#runs.doc(encodeURIComponent(runId));
  }

  #outboxRef(entryId: string): DocumentReference {
    return this.#outbox.doc(encodeURIComponent(entryId));
  }
}
