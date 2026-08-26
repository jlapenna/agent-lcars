import type { Decision } from './decide';
import type { LeasedOutboxEntry, OutboxEntry, Run, TaskId } from './model';
import { isLive, isWorkAnchor, taskKey } from './model';
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
    decision: Decision;
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
    if (decision.run !== undefined) {
      this.#runs.set(decision.run.runId, structuredClone(decision.run));
    }
    for (const entry of decision.outbox) {
      this.#outbox.set(entry.entryId, structuredClone(entry));
    }
  }

  async claimPendingOutbox(input: {
    limit: number;
    now: string;
    leaseExpiresAt: string;
  }): Promise<LeasedOutboxEntry[]> {
    if (input.limit <= 0) return [];

    const now = Date.parse(input.now);
    const entries = [...this.#outbox.values()];
    const eligible = [
      ...entries.filter(
        (entry) =>
          entry.state === 'leased' && Date.parse(entry.leaseExpiresAt) <= now,
      ),
      ...entries.filter((entry) => entry.state === 'pending'),
    ].slice(0, input.limit);

    const claimed = eligible.map((entry): LeasedOutboxEntry => {
      const { state: _state, ...rest } = entry;
      const next: LeasedOutboxEntry = {
        ...rest,
        state: 'leased',
        claimId: crypto.randomUUID(),
        leaseExpiresAt: input.leaseExpiresAt,
        attempts: entry.attempts + 1,
        updatedAt: input.now,
      };
      this.#outbox.set(entry.entryId, next);
      return next;
    });
    return structuredClone(claimed);
  }

  async settleOutbox(input: {
    entryId: string;
    claimId: string;
    state: 'pending' | 'done';
    now: string;
  }): Promise<boolean> {
    const entry = this.#outbox.get(input.entryId);
    if (
      entry === undefined ||
      entry.state !== 'leased' ||
      entry.claimId !== input.claimId
    ) {
      return false;
    }
    const {
      claimId: _claimId,
      leaseExpiresAt: _leaseExpiresAt,
      ...rest
    } = entry;
    this.#outbox.set(input.entryId, {
      ...rest,
      state: input.state,
      updatedAt: input.now,
    });
    return true;
  }

  async listNativeTasks(): Promise<VersionedTask[]> {
    return structuredClone(
      [...this.#tasks.values()].filter((entry) =>
        isWorkAnchor(entry.task.task),
      ),
    );
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
