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
   * `leaseExpiresAt`; attempts increments only for claims actually acquired
   * -- including expired-lease recovery, which is a claim but not itself a
   * delivery attempt (see `OutboxEntry.attempts`'s doc comment in
   * `model.ts`).
   *
   * `excludeEntryIds` (#1548), when given, skips those entryIds when
   * choosing which *pending* entries to claim -- it does not affect expired-
   * lease recovery. A caller draining entries one at a time uses this to
   * keep a persistently-failing entry it already tried this invocation from
   * being reclaimed ahead of every other pending entry: an implementation's
   * claim order (see `byOutboxClaimFairness` in `model.ts`) favors an
   * entry's `attempts` count over anything else, but two due entries tied
   * on `attempts` -- e.g. a batch that just failed together -- would
   * otherwise still let the same one win the tie every time, indefinitely,
   * without this exclusion.
   *
   * A *pending* entry whose `nextAttemptAt` is still in the future (#1548
   * follow-up: backoff after a delivery failure) is likewise skipped --
   * silently, the same as `excludeEntryIds` -- until that instant passes;
   * this never affects expired-lease recovery either, since a lease can
   * only be outstanding on an entry that was itself already eligible to be
   * claimed. Skipping it this way, rather than returning it and having the
   * caller decline to act on it, keeps a backing-off entry from being
   * mistaken for a claim this invocation attempted and failed.
   */
  claimPendingOutbox(input: {
    limit: number;
    now: string;
    leaseExpiresAt: string;
    excludeEntryIds?: ReadonlySet<string>;
  }): Promise<LeasedOutboxEntry[]>;
  /**
   * Completes or releases a lease only while `claimId` still owns it. Returns
   * false for missing entries and stale claims without changing stored state.
   * `'failed'` (#1548) retires an entry permanently -- see `OutboxEntry`'s
   * `failed` state in `model.ts`.
   *
   * `firstFailedAt`/`nextAttemptAt`/`deliveryFailures` (#1548 follow-up),
   * when given, are written onto the entry atomically with the state
   * transition -- the caller uses this when releasing a real delivery
   * failure back to `pending` (or retiring it to `failed`) to record the
   * elapsed-time/backoff bookkeeping in the same transaction, rather than
   * as a separate write a crash could tear apart from the settle itself.
   * Omitted (`undefined`) leaves the corresponding field on the stored
   * entry unchanged -- every other settle path (a successful delivery, a
   * permanent failure) omits all three and so never touches them.
   */
  settleOutbox(input: {
    entryId: string;
    claimId: string;
    state: 'pending' | 'done' | 'failed';
    now: string;
    firstFailedAt?: string;
    nextAttemptAt?: string;
    deliveryFailures?: number;
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
   * scan. `before`, when given, is a `workId` from a previous page's last
   * entry: the read starts strictly after it in the same newest-first
   * order, so repeatedly calling with the previous page's last `workId`
   * walks every native task exactly once, oldest page last -- the cursor
   * `work-router.ts`'s `list` exposes as `nextCursor` (issue #1546: the
   * single `limit`-bounded read this replaced silently dropped any native
   * task past the newest `limit`, however that page's items were later
   * filtered).
   */
  listNativeTasks(limit?: number, before?: string): Promise<VersionedTask[]>;

  /** Every live (`pending`/`running`) run, lease or no lease. The feed for
   *  settling runs whose *executor* is already terminal -- a fact only
   *  something outside the orchestrator can observe, so the caller resolves
   *  it and hands the verdicts back to
   *  `Orchestrator.settleTerminalRuns`. Deliberately unfiltered by lease:
   *  the whole point is to catch a run long before its lease runs out. */
  listLiveRuns(): Promise<Run[]>;

  /** Writes `run.queue = { state: 'queued' }` on a run the drain is
   *  handling as `executor: 'queue'`. Idempotent: a run already `queued`
   *  or `claimed` is left untouched. */
  enqueueRun(input: { runId: string; now: string }): Promise<void>;

  /** Transactionally claims the oldest (`createdAt`) `queued` run whose
   *  `pipeline` is one of `pipelines`, setting `queue.state = 'claimed'`
   *  plus `claimedAt`/`claimedBy`/`tokenHash`. `undefined` when nothing is
   *  queued for those pipelines. */
  claimQueuedRun(input: {
    pipelines: readonly string[];
    now: string;
    claimedBy: string;
    tokenHash: string;
  }): Promise<Run | undefined>;

  /** Every `queue.state === 'queued'` run, oldest first, bounded by
   *  `limit` (default 200). */
  listQueuedRuns(limit?: number): Promise<Run[]>;
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
