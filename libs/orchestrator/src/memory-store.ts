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

  async listNativeTasks(
    limit?: number,
    before?: string,
  ): Promise<VersionedTask[]> {
    // Newest first, matching `FirestoreStore`: `workId` is a ULID, so
    // descending lexicographic order on it is descending creation order.
    // `before`, when given, drops everything from `workId === before`
    // onward -- the same "strictly after the cursor, in this same order"
    // cut `FirestoreStore.startAfter` makes.
    const native = [...this.#tasks.values()]
      .map((entry) => {
        const id = entry.task.task;
        return { entry, workId: isWorkAnchor(id) ? id.workId : undefined };
      })
      .filter(
        (item): item is { entry: VersionedTask; workId: string } =>
          item.workId !== undefined &&
          (before === undefined || item.workId < before),
      )
      .sort((a, b) => b.workId.localeCompare(a.workId))
      .map(({ entry }) => entry);
    return structuredClone(native.slice(0, limit ?? 200));
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

  async enqueueRun(input: { runId: string; now: string }): Promise<void> {
    const run = this.#runs.get(input.runId);
    if (run === undefined || run.queue !== undefined) return;
    this.#runs.set(input.runId, {
      ...run,
      queue: { state: 'queued' },
      updatedAt: input.now,
    });
  }

  async claimQueuedRun(input: {
    pipelines: readonly string[];
    now: string;
    claimedBy: string;
    tokenHash: string;
  }): Promise<Run | undefined> {
    const pipelines = new Set(input.pipelines);
    const candidate = [...this.#runs.values()]
      .filter(
        (run) => run.queue?.state === 'queued' && pipelines.has(run.pipeline),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (candidate === undefined) return undefined;
    const claimed: Run = {
      ...candidate,
      queue: {
        state: 'claimed',
        claimedAt: input.now,
        claimedBy: input.claimedBy,
        tokenHash: input.tokenHash,
      },
      updatedAt: input.now,
    };
    this.#runs.set(candidate.runId, claimed);
    return structuredClone(claimed);
  }

  async listQueuedRuns(limit?: number): Promise<Run[]> {
    return structuredClone(
      [...this.#runs.values()]
        .filter((run) => run.queue?.state === 'queued')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit ?? 200),
    );
  }
}
