import { type Decision, isQueued, type Queued } from './decide';
import type { OutboxEntry, Run, TaskId } from './model';
import { isLive, taskKey } from './model';
import {
  type OrchestratorStore,
  StoreConflict,
  type VersionedTask,
} from './store';

/** Reference implementation; also the test double. */
export class MemoryStore implements OrchestratorStore {
  readonly #tasks = new Map<string, VersionedTask>();
  readonly #runs = new Map<string, Run>();
  readonly #outbox = new Map<string, OutboxEntry>();

  async readTask(id: TaskId): Promise<VersionedTask | undefined> {
    return structuredClone(this.#tasks.get(taskKey(id)));
  }

  async readRun(runId: string): Promise<Run | undefined> {
    return structuredClone(this.#runs.get(runId));
  }

  async readActiveRun(id: TaskId): Promise<Run | undefined> {
    const active = this.#tasks.get(taskKey(id))?.task.activeRunId;
    return active === undefined
      ? undefined
      : structuredClone(this.#runs.get(active));
  }

  async listRuns(id: TaskId): Promise<Run[]> {
    const key = taskKey(id);
    return structuredClone(
      [...this.#runs.values()].filter((run) => taskKey(run.task) === key),
    );
  }

  async apply(input: {
    decision: Decision | Queued;
    expectedRevision: number | undefined;
  }): Promise<void> {
    const { decision, expectedRevision } = input;
    const key = taskKey(decision.task.task);
    const current = this.#tasks.get(key);
    if (current?.revision !== expectedRevision) {
      throw new StoreConflict(decision.task.task);
    }
    this.#tasks.set(key, {
      task: structuredClone(decision.task),
      revision: (expectedRevision ?? 0) + 1,
    });
    if (isQueued(decision)) return; // task-only write: no run, no outbox
    this.#runs.set(decision.run.runId, structuredClone(decision.run));
    if (decision.followUpRun !== undefined) {
      this.#runs.set(
        decision.followUpRun.runId,
        structuredClone(decision.followUpRun),
      );
    }
    for (const entry of decision.outbox) {
      this.#outbox.set(entry.entryId, structuredClone(entry));
    }
  }

  async claimPendingOutbox(limit: number): Promise<OutboxEntry[]> {
    const pending = [...this.#outbox.values()]
      .filter((entry) => entry.state === 'pending')
      .slice(0, limit);
    for (const entry of pending) {
      this.#outbox.set(entry.entryId, {
        ...entry,
        attempts: entry.attempts + 1,
      });
    }
    return structuredClone(pending);
  }

  async settleOutbox(
    entryId: string,
    state: 'pending' | 'done',
  ): Promise<void> {
    const entry = this.#outbox.get(entryId);
    if (entry !== undefined) this.#outbox.set(entryId, { ...entry, state });
  }

  async listExpiredRuns(now: string): Promise<Run[]> {
    const cutoff = Date.parse(now);
    return structuredClone(
      (await this.listLiveRuns()).filter(
        (run) => Date.parse(run.leaseExpiresAt) <= cutoff,
      ),
    );
  }

  async listLiveRuns(): Promise<Run[]> {
    return structuredClone(
      [...this.#runs.values()].filter((run) => isLive(run.state)),
    );
  }
}
