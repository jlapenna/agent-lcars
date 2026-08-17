import type { Decision, Queued } from './decide';
import type { OutboxEntry, Run, Task, TaskId } from './model';
import { taskKey } from './model';

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
  /** `decision` is `Queued` for `requestRun`'s `queueIfBusy` outcome -- a
   *  task-only write, no run and no outbox entry to commit. */
  apply(input: {
    decision: Decision | Queued;
    /** Revision the decision was computed against; undefined = task is new. */
    expectedRevision: number | undefined;
  }): Promise<void>;

  /** Outbox draining, used by the delivery worker, not the decision layer. */
  claimPendingOutbox(limit: number): Promise<OutboxEntry[]>;
  settleOutbox(entryId: string, state: 'pending' | 'done'): Promise<void>;

  /** Live runs whose lease expired at or before `now`; the sweeper's feed. */
  listExpiredRuns(now: string): Promise<Run[]>;

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
