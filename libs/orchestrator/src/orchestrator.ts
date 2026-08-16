import {
  cancelRun,
  confirmDispatch,
  type Decision,
  expireLease,
  isRefusal,
  MAX_AUTO_RETRIES,
  type Queued,
  type Refusal,
  renewLease,
  reportResult,
  requestRun,
} from './decide';
import type { Run, RunResult, TaskId } from './model';
import {
  type OrchestratorStore,
  StoreConflict,
  type VersionedTask,
} from './store';

type Decide<T extends Decision | Queued> = (
  task: VersionedTask | undefined,
  activeRun: Run | undefined,
) => Promise<T | Refusal> | T | Refusal;

export interface Clock {
  now(): string;
}

export interface SweepResult {
  /** Runs settled `lost` by this sweep. */
  readonly lost: Run[];
  /** Each lost run this sweep successfully auto-retried, paired with the
   *  fresh run it started. A lost run absent from this list either
   *  exhausted its task's auto-retry budget or had its retry request
   *  refused (e.g. an operator's manual request raced and won). */
  readonly retried: { lostRunId: string; newRunId: string }[];
}

/**
 * Read → decide → apply, with one retry on a lost compare-and-set. The
 * decision layer is pure; this class is the only place I/O and time meet it.
 */
export interface RequestInput {
  taskId: TaskId;
  requestId: string;
  pipeline: string;
  params?: Record<string, string>;
  /** See `requestRun`'s own `queueIfBusy` doc comment in `decide.ts`. */
  queueIfBusy?: boolean;
}

export class Orchestrator {
  constructor(
    private readonly store: OrchestratorStore,
    private readonly clock: Clock,
  ) {}

  /**
   * Three overloads, mirroring `requestRun`'s own: omitting `queueIfBusy`
   * (or passing `false`) keeps the return type exactly `Decision | Refusal`,
   * so every existing caller -- none of which pass the flag in this repo
   * yet -- needs no changes at all; passing the literal `true` adds
   * `Queued`; the general (non-literal `boolean`) fallback exists only so a
   * caller forwarding a runtime flag value (or overriding this method, as
   * the test double in `orchestrator.spec.ts` does) can still call/implement
   * it without losing type safety.
   */
  request(
    input: RequestInput & { queueIfBusy?: false },
  ): Promise<Decision | Refusal>;
  request(
    input: RequestInput & { queueIfBusy: true },
  ): Promise<Decision | Refusal | Queued>;
  request(input: RequestInput): Promise<Decision | Refusal | Queued>;
  async request(input: RequestInput): Promise<Decision | Refusal | Queued> {
    return this.transact<Decision | Queued>(
      input.taskId,
      async (task, activeRun) =>
        requestRun({
          now: this.clock.now(),
          task: task?.task,
          taskId: input.taskId,
          activeRun,
          requestId: input.requestId,
          pipeline: input.pipeline,
          ...(input.params === undefined ? {} : { params: input.params }),
          queueIfBusy: input.queueIfBusy,
        }),
    );
  }

  async confirmDispatch(runId: string): Promise<Decision | Refusal> {
    return this.transactOnRun(runId, (task, run) =>
      confirmDispatch({ now: this.clock.now(), task, run }),
    );
  }

  async renew(runId: string): Promise<Decision | Refusal> {
    return this.transactOnRun(runId, (task, run) =>
      renewLease({ now: this.clock.now(), task, run }),
    );
  }

  async report(runId: string, result: RunResult): Promise<Decision | Refusal> {
    return this.transactOnRun(runId, (task, run) =>
      reportResult({ now: this.clock.now(), task, run, result }),
    );
  }

  async cancel(runId: string, note?: string): Promise<Decision | Refusal> {
    return this.transactOnRun(runId, (task, run) =>
      cancelRun({
        now: this.clock.now(),
        task,
        run,
        ...(note === undefined ? {} : { note }),
      }),
    );
  }

  /**
   * Settle every live run whose lease has expired, then -- for each one
   * whose task is still within its auto-retry budget -- immediately request
   * a fresh run for the same task, copying the lost run's pipeline and
   * params verbatim. A task whose runs go lost more than `MAX_AUTO_RETRIES`
   * times in a row exhausts its budget and is left parked rather than
   * retried forever.
   *
   * The retry request uses a deterministic requestId (`retry:<lostRunId>`),
   * so re-issuing it -- a re-sweep landing on the same run, or a caller
   * retrying after a crash -- maps to the run already created instead of
   * starting a second one; this is the same duplicate-request idempotency
   * `request()` already gives every caller, not a new mechanism.
   *
   * A refusal on the retry request (most likely `task-busy`, when an
   * operator manually re-requested the task in the window between the
   * expire commit and this call) is not an error: something is already
   * live for the task, so this simply records no retry for that run.
   *
   * KNOWN GAP: a crash between the expire commit (already durable, via the
   * `transactOnRun` call above) and the retry request below is not itself
   * durable -- that one auto-retry is lost, and the task is left merely
   * unlocked, exactly as it was before this feature existed. A manual
   * request still works. Accepted for this fleet: the deterministic
   * requestId keeps the common (no-crash) path idempotent, which is the
   * case that actually recurs -- the sweep itself runs repeatedly.
   */
  async sweepExpired(): Promise<SweepResult> {
    const now = this.clock.now();
    const lost: Run[] = [];
    const retried: { lostRunId: string; newRunId: string }[] = [];
    for (const run of await this.store.listExpiredRuns(now)) {
      const outcome = await this.transactOnRun(run.runId, (task, current) =>
        expireLease({ now, task, run: current }),
      );
      if (isRefusal(outcome)) continue;
      lost.push(outcome.run);

      if ((outcome.task.consecutiveLost ?? 0) > MAX_AUTO_RETRIES) continue;
      const retry = await this.request({
        taskId: outcome.run.task,
        requestId: `retry:${outcome.run.runId}`,
        pipeline: outcome.run.pipeline,
        ...(outcome.run.params === undefined
          ? {}
          : { params: outcome.run.params }),
      });
      if (!isRefusal(retry)) {
        retried.push({
          lostRunId: outcome.run.runId,
          newRunId: retry.run.runId,
        });
      }
    }
    return { lost, retried };
  }

  async #once<T extends Decision | Queued>(
    taskId: TaskId,
    decide: Decide<T>,
  ): Promise<T | Refusal> {
    const task = await this.store.readTask(taskId);
    const activeRun = await this.store.readActiveRun(taskId);
    const outcome = await decide(task, activeRun);
    if (isRefusal(outcome)) return outcome;
    await this.store.apply({
      decision: outcome,
      expectedRevision: task?.revision,
    });
    return outcome;
  }

  private async transact<T extends Decision | Queued = Decision>(
    taskId: TaskId,
    decide: Decide<T>,
  ): Promise<T | Refusal> {
    try {
      return await this.#once(taskId, decide);
    } catch (error) {
      if (!(error instanceof StoreConflict)) throw error;
      // Lost the race; the winner may have changed the answer. Re-decide
      // exactly once against fresh state — a second loss is surfaced.
      return this.#once(taskId, decide);
    }
  }

  private async transactOnRun(
    runId: string,
    decide: (task: VersionedTask['task'], run: Run) => Decision | Refusal,
  ): Promise<Decision | Refusal> {
    const run = await this.store.readRun(runId);
    if (run === undefined) return { refused: true, reason: 'unknown-run' };
    return this.transact(run.task, async (task) => {
      const current = await this.store.readRun(runId);
      if (task === undefined || current === undefined) {
        return { refused: true, reason: 'unknown-run' } as Refusal;
      }
      return decide(task.task, current);
    });
  }
}
