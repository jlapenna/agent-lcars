import {
  type CollectionReference,
  type DocumentReference,
  Firestore,
} from '@google-cloud/firestore';
import { z } from 'zod';

import { type Decision, isQueued, type Queued } from './decide';
import {
  isLive,
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
    // Two fields, both filtered with `==`: an equality-only compound query,
    // which Firestore serves from the automatic single-field indexes
    // without a composite index.
    const snapshot = await this.#runs
      .where('task.repo', '==', id.repo)
      .where('task.issue', '==', id.issue)
      .get();
    return snapshot.docs.map((doc) => runSchema.parse(doc.data()));
  }

  async apply(input: {
    decision: Decision | Queued;
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

      if (isQueued(decision)) return; // task-only write: no run, no outbox

      tx.set(this.#runRef(decision.run.runId), decision.run);
      if (decision.followUpRun !== undefined) {
        tx.set(this.#runRef(decision.followUpRun.runId), decision.followUpRun);
      }
      for (const entry of decision.outbox) {
        tx.set(this.#outboxRef(entry.entryId), entry);
      }
    });
  }

  async claimPendingOutbox(limit: number): Promise<OutboxEntry[]> {
    const snapshot = await this.#outbox
      .where('state', '==', 'pending')
      .limit(limit)
      .get();
    const claimed: OutboxEntry[] = [];
    for (const doc of snapshot.docs) {
      // Mirrors MemoryStore's own behaviour: the stored `attempts` is
      // incremented as claim bookkeeping (for whoever looks next time),
      // but the entry handed back here reflects the pre-claim snapshot,
      // not the post-increment one.
      const claimedEntry = outboxEntrySchema.parse(doc.data());
      // A transaction per entry is fine at this scale; it guarantees the
      // increment is never lost to a racing claim of the same entry.
      await this.#firestore.runTransaction(async (tx) => {
        const current = await tx.get(doc.ref);
        if (!current.exists) return;
        const parsed = outboxEntrySchema.parse(current.data());
        tx.set(doc.ref, { ...parsed, attempts: parsed.attempts + 1 });
      });
      claimed.push(claimedEntry);
    }
    return claimed;
  }

  async settleOutbox(
    entryId: string,
    state: 'pending' | 'done',
  ): Promise<void> {
    const ref = this.#outboxRef(entryId);
    await this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return; // no-op, matching MemoryStore
      const current = outboxEntrySchema.parse(snapshot.data());
      tx.set(ref, { ...current, state });
    });
  }

  async listExpiredRuns(now: string): Promise<Run[]> {
    const cutoff = Date.parse(now);
    // A single query for `state in [...] AND leaseExpiresAt <= now` would
    // combine an equality/`in` filter with a range filter on a *different*
    // field, which Firestore only serves with a composite index. Rather
    // than require one, run one single-field equality query per live state
    // (each covered by Firestore's automatic single-field index), and
    // apply the lease-expiry filter client-side, merging the results.
    const perState = await Promise.all(
      LIVE_STATES.map((state) => this.#runs.where('state', '==', state).get()),
    );
    const expired: Run[] = [];
    for (const snapshot of perState) {
      for (const doc of snapshot.docs) {
        const run = runSchema.parse(doc.data());
        if (Date.parse(run.leaseExpiresAt) <= cutoff) expired.push(run);
      }
    }
    return expired;
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
