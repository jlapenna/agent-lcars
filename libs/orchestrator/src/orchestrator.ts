import {
  cancelRun,
  confirmDispatch,
  type Decision,
  expireLease,
  isRefusal,
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

type Decide = (
  task: VersionedTask | undefined,
  activeRun: Run | undefined,
) => Promise<Decision | Refusal> | Decision | Refusal;

export interface Clock {
  now(): string;
}

/**
 * Read → decide → apply, with one retry on a lost compare-and-set. The
 * decision layer is pure; this class is the only place I/O and time meet it.
 */
export class Orchestrator {
  constructor(
    private readonly store: OrchestratorStore,
    private readonly clock: Clock,
  ) {}

  async request(input: {
    taskId: TaskId;
    requestId: string;
    pipeline: string;
  }): Promise<Decision | Refusal> {
    return this.transact(input.taskId, async (task, activeRun) =>
      requestRun({
        now: this.clock.now(),
        task: task?.task,
        taskId: input.taskId,
        activeRun,
        requestId: input.requestId,
        pipeline: input.pipeline,
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

  /** Settle every live run whose lease has expired. Returns those settled. */
  async sweepExpired(): Promise<Run[]> {
    const now = this.clock.now();
    const settled: Run[] = [];
    for (const run of await this.store.listExpiredRuns(now)) {
      const outcome = await this.transactOnRun(run.runId, (task, current) =>
        expireLease({ now, task, run: current }),
      );
      if (!isRefusal(outcome)) settled.push(outcome.run);
    }
    return settled;
  }

  async #once(taskId: TaskId, decide: Decide): Promise<Decision | Refusal> {
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

  private async transact(
    taskId: TaskId,
    decide: Decide,
  ): Promise<Decision | Refusal> {
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
