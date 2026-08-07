/**
 * In-memory reference implementation of `StoragePort` (#645 Phase 5, second
 * bullet). Its whole job is to make `./port.contract.ts`'s suite pass so the
 * contract itself is proven satisfiable, and to give tests elsewhere in this
 * codebase a real port to exercise without standing up any infrastructure.
 *
 * Not durable, not concurrent-safe across processes, and not wired into the
 * live dispatch path -- state lives in a plain `Map` that disappears with
 * the process. That is fine for what this class is for (a reference and a
 * test fixture) and would be disqualifying for what Phase 6 eventually needs
 * (a backing store an agent cannot forge); this class is deliberately not
 * that. A future backend earns trust by passing the same contract suite,
 * not by resembling this file.
 */

import {
  type LaunchOutboxOperation,
  type LaunchOutboxResolution,
  type StoragePort,
  type StoredTask,
  type StoredTaskInput,
  taskKey,
  type TaskRef,
  TaskWriteConflictError,
} from './port.js';

function defaultNow(): string {
  return new Date().toISOString();
}

/** Structural deep-equality for the small, JSON-shaped values this file
 *  compares (`LaunchOutboxResolution`). Not a general-purpose deep-equal --
 *  scoped to exactly what `resolveLaunchOutcome`'s idempotence check needs,
 *  the same way `canonicalJson`/`digest` in broker.ts are scoped to the
 *  ledger's own equality needs rather than pulling in a shared library. */
function sameResolution(
  a: LaunchOutboxResolution,
  b: LaunchOutboxResolution,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class InMemoryStoragePort implements StoragePort {
  #tasks = new Map<string, StoredTask>();
  #outbox = new Map<string, LaunchOutboxOperation>();

  async readTask(task: TaskRef): Promise<StoredTask | undefined> {
    const stored = this.#tasks.get(taskKey(task));
    // Defensive clone: the map holds the port's own copy, so a caller
    // mutating what it read must never corrupt what a later readTask sees --
    // the same isolation `structuredClone` gives ledger-core.ts's
    // `createLedger`.
    return stored ? structuredClone(stored) : undefined;
  }

  async writeTask(
    task: TaskRef,
    expectedRevision: number | undefined,
    next: StoredTaskInput,
    now: string = defaultNow(),
  ): Promise<StoredTask> {
    const key = taskKey(task);
    const current = this.#tasks.get(key);
    if (current?.revision !== expectedRevision) {
      throw new TaskWriteConflictError(
        task,
        expectedRevision,
        current?.revision,
      );
    }
    const stored: StoredTask = {
      ...structuredClone(next),
      task: structuredClone(task),
      revision: (expectedRevision ?? 0) + 1,
      updatedAt: now,
    };
    this.#tasks.set(key, stored);
    return structuredClone(stored);
  }

  async recordLaunchIntent(
    operation: { operationId: string; task: TaskRef; attemptId: string },
    now: string = defaultNow(),
  ): Promise<LaunchOutboxOperation> {
    const existing = this.#outbox.get(operation.operationId);
    if (existing) {
      const sameOperation =
        existing.attemptId === operation.attemptId &&
        taskKey(existing.task) === taskKey(operation.task);
      if (!sameOperation) {
        throw new Error(
          `Launch outbox operation ID reused for a different attempt: ${operation.operationId}`,
        );
      }
      // At-least-once record: the caller may retry the record step before
      // the dispatch call ever happens. Returning the existing entry
      // unchanged, rather than re-recording, is what makes that retry safe.
      return structuredClone(existing);
    }
    const created: LaunchOutboxOperation = {
      operationId: operation.operationId,
      task: structuredClone(operation.task),
      attemptId: operation.attemptId,
      recordedAt: now,
      status: 'pending',
    };
    this.#outbox.set(operation.operationId, created);
    return structuredClone(created);
  }

  async resolveLaunchOutcome(
    operationId: string,
    resolution: LaunchOutboxResolution,
    now: string = defaultNow(),
  ): Promise<LaunchOutboxOperation> {
    const existing = this.#outbox.get(operationId);
    if (!existing) {
      throw new Error(
        `Cannot resolve launch outbox operation that was never recorded: ${operationId}`,
      );
    }
    if (existing.status !== 'pending') {
      if (
        existing.resolution &&
        sameResolution(existing.resolution, resolution)
      ) {
        // Same idempotence posture as recordLaunchIntent: the caller may
        // retry the resolve step after it already landed.
        return structuredClone(existing);
      }
      throw new Error(
        `Launch outbox operation ${operationId} already resolved as ` +
          `${existing.status}; refusing to overwrite with a different resolution`,
      );
    }
    const resolved: LaunchOutboxOperation = {
      ...existing,
      status: resolution.status,
      resolvedAt: now,
      resolution,
    };
    this.#outbox.set(operationId, resolved);
    return structuredClone(resolved);
  }

  async readLaunchOperation(
    operationId: string,
  ): Promise<LaunchOutboxOperation | undefined> {
    const stored = this.#outbox.get(operationId);
    return stored ? structuredClone(stored) : undefined;
  }

  async listPendingLaunchOperations(): Promise<LaunchOutboxOperation[]> {
    return [...this.#outbox.values()]
      .filter((operation) => operation.status === 'pending')
      .map((operation) => structuredClone(operation));
  }
}
