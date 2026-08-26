import type { Decision } from './decide';
import type { LeasedOutboxEntry, Run, Task, TaskId } from './model';
import { taskKey } from './model';

/** GitHub delivery normally takes seconds; five minutes tolerates a slow call
 *  while still making a crashed drain retryable promptly. */
export const OUTBOX_LEASE_MS = 5 * 60_000;

/**
 * Durability boundary. One method per question the decision layer asks, one
 * method to apply a decision atomically. Implementations must guarantee:
 *
 * - `apply` commits the task, the run, and the outbox entries together or
 *   not at all;
 * - `apply` fails if the task changed since it was read (`expectedRevision`),
 *   so two racing writers cannot both take the lock.
 *
 * That compare-and-set is the entire concurrency story. There are no leases
 * on the storage layer itself — the task document's revision is the lock's
 * ground truth, and Firestore transactions provide it natively.
 */
export interface OrchestratorStore {
  readTask(id: TaskId): Promise<VersionedTask | undefined>;
  readRun(runId: string): Promise<Run | undefined>;
  /** The task's live run, if its `activeRunId` points at one. */
  readActiveRun(id: TaskId): Promise<Run | undefined>;
  listRuns(id: TaskId): Promise<Run[]>;
  apply(input: {
    decision: Decision;
    /** Revision the decision was computed against; undefined = task is new. */
    expectedRevision: number | undefined;
  }): Promise<void>;

  /**
   * Atomically leases up to `limit` pending or expired outbox entries. Every
   * returned entry is exclusively owned by its `claimId` until
   * `leaseExpiresAt`; attempts increments only for claims actually acquired.
   */
  claimPendingOutbox(input: {
    limit: number;
    now: string;
    leaseExpiresAt: string;
  }): Promise<LeasedOutboxEntry[]>;
  /**
   * Completes or releases a lease only while `claimId` still owns it. Returns
   * false for missing entries and stale claims without changing stored state.
   */
  settleOutbox(input: {
    entryId: string;
    claimId: string;
    state: 'pending' | 'done';
    now: string;
  }): Promise<boolean>;

  /** Live runs whose lease expired at or before `now`; the sweeper's feed. */
  listExpiredRuns(now: string): Promise<Run[]>;

  /**
   * Every native (work-anchored) task; GitHub-anchored tasks are excluded.
   * Newest first (workId is a ULID, so lexicographic order on it is
   * creation order) -- the caller may still re-sort what it renders, but
   * a caller that doesn't gets the most useful order for free. This is a
   * read: the console's items API needs "what native work exists", a
   * question the per-task accessors above cannot answer, and nothing in
   * the decision layer uses it.
   *
   * `limit` bounds the read at the store, not just what the caller renders
   * -- default 200, so an unbounded caller still can't force a full table
   * scan.
   */
  listNativeTasks(limit?: number): Promise<VersionedTask[]>;

  /** Every live (`pending`/`running`) run, lease or no lease. The feed for
   *  settling runs whose *executor* is already terminal -- a fact only
   *  something outside the orchestrator can observe, so the caller resolves
   *  it and hands the verdicts back to
   *  `Orchestrator.settleTerminalRuns`. Deliberately unfiltered by lease:
   *  the whole point is to catch a run long before its lease runs out. */
  listLiveRuns(): Promise<Run[]>;
}

export interface VersionedTask {
  readonly task: Task;
  readonly revision: number;
}

/** Thrown by `apply` when the compare-and-set loses. Callers retry by
 *  re-reading and re-deciding; they never force the write. */
export class StoreConflict extends Error {
  override readonly name = 'StoreConflict';
  constructor(id: TaskId) {
    super(`Concurrent update to task ${taskKey(id)}`);
  }
}
