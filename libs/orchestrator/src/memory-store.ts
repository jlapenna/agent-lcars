import { z } from 'zod';

import { type Decision, isRefusal, type Refusal } from './decide';
import type {
  GithubAnchorProjection,
  LeasedOutboxEntry,
  OutboxEntry,
  RequestSource,
  Run,
  TaskDocument,
  TaskId,
} from './model';
import {
  byOutboxClaimFairness,
  githubAnchorProjectionSchema,
  isLive,
  isWorkAnchor,
  requestHistoryKey,
  RUN_ID_MAX_LENGTH,
  runStateSchema,
  taskIdSchema,
  taskKey,
} from './model';
import {
  decodePersistedMigrationAddress,
  decodePersistedMigrationCursor,
  encodePersistedMigrationCursor,
  fingerprint,
  inventoryPersistedRecord,
  isPersistedMigrationDeleteEntry,
  manifestId,
  migrationParentTaskMatchesRun,
  PERSISTED_MIGRATION_PAGE_MAX,
  PersistedMigrationConflict,
  PersistedMigrationCursorError,
  type PersistedMigrationDeleteBlockReason,
  type PersistedMigrationDeleteEntry,
  type PersistedMigrationDeleteReadiness,
  type PersistedMigrationEntry,
  type PersistedMigrationPreview,
  type PersistedRecordKind,
  type PersistedRecordPage,
  type PersistedRecordSelector,
  validateManifest,
} from './persisted-record-migration';
import {
  type OrchestratorStore,
  type RequestTransactionState,
  StoreConflict,
  type TaskListCursor,
  type VersionedTask,
} from './store';

const migrationRunIdSchema = z.string().min(1).max(RUN_ID_MAX_LENGTH);
const migrationRunSafetySchema = z
  .object({
    runId: migrationRunIdSchema,
    task: taskIdSchema,
    state: runStateSchema,
  })
  .strip();
const migrationTaskSafetySchema = z
  .object({
    task: z
      .object({
        task: taskIdSchema,
        activeRunId: migrationRunIdSchema.optional(),
      })
      .strip(),
  })
  .strip();
const migrationOutboxSafetySchema = z
  .object({
    entryId: z.string().min(1),
    task: taskIdSchema,
    runId: migrationRunIdSchema,
    state: z.enum(['pending', 'leased', 'done', 'failed']),
  })
  .strip();

function selectorMatchesTask(
  selector: PersistedRecordSelector,
  task: TaskId,
): boolean {
  if ('address' in selector) {
    return (
      decodePersistedMigrationAddress(selector.address, 'task') ===
      encodeURIComponent(taskKey(task))
    );
  }
  return selector.kind === 'task' && taskKey(selector.task) === taskKey(task);
}

function selectorMatchesRun(
  selector: PersistedRecordSelector,
  runId: string,
): boolean {
  if ('address' in selector) {
    return (
      decodePersistedMigrationAddress(selector.address, 'run') ===
      encodeURIComponent(runId)
    );
  }
  return selector.kind === 'run' && selector.runId === runId;
}

function selectorMatchesOutbox(
  selector: PersistedRecordSelector,
  entryId: string,
): boolean {
  if ('address' in selector) {
    return (
      decodePersistedMigrationAddress(selector.address, 'outbox') ===
      encodeURIComponent(entryId)
    );
  }
  return selector.kind === 'outbox' && selector.entryId === entryId;
}

/** Reference implementation; also the test double. */
export class MemoryStore implements OrchestratorStore {
  readonly #tasks = new Map<string, VersionedTask>();
  readonly #runs = new Map<string, Run>();
  readonly #requestRuns = new Map<string, string>();
  readonly #outbox = new Map<string, OutboxEntry>();
  readonly #githubAnchorProjections = new Map<
    string,
    { projection?: GithubAnchorProjection; refreshGeneration: number }
  >();

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

  async transactRequest(input: {
    taskId: TaskId;
    requestId: string;
    requestSource: RequestSource;
    decide(state: RequestTransactionState): Decision | Refusal;
  }): Promise<Decision | Refusal> {
    // Do not await while this snapshot and its accepted write are in flight:
    // the in-memory implementation is our reference transaction, so two
    // overlapping callers cannot both observe an absent request id and mint
    // separate runs.
    const key = taskKey(input.taskId);
    const task = structuredClone(this.#tasks.get(key));
    const activeRunId = task?.task.activeRunId;
    const activeRun =
      activeRunId === undefined
        ? undefined
        : structuredClone(this.#runs.get(activeRunId));
    const previousRunId = this.#requestRuns.get(
      this.#requestKey(input.taskId, input.requestSource, input.requestId),
    );
    const previousRun =
      previousRunId === undefined
        ? undefined
        : structuredClone(this.#runs.get(previousRunId));
    const outcome = input.decide({ task, activeRun, previousRun });
    if (isRefusal(outcome)) return outcome;
    this.#apply({ decision: outcome, expectedRevision: task?.revision });
    return outcome;
  }

  async apply(input: {
    decision: Decision;
    expectedRevision: number | undefined;
  }): Promise<void> {
    this.#apply(input);
  }

  #apply(input: {
    decision: Decision;
    expectedRevision: number | undefined;
  }): void {
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
      this.#requestRuns.set(
        this.#requestKey(
          decision.run.task,
          decision.run.requestSource ?? 'caller',
          decision.run.requestId,
        ),
        decision.run.runId,
      );
    }
    for (const entry of decision.outbox) {
      this.#outbox.set(entry.entryId, structuredClone(entry));
    }
  }

  #requestKey(id: TaskId, source: RequestSource, requestId: string): string {
    return JSON.stringify([taskKey(id), requestHistoryKey(source, requestId)]);
  }

  async beginGithubAnchorProjectionRefresh(
    anchor: GithubAnchorProjection['anchor'],
  ): Promise<number> {
    const key = taskKey(anchor);
    const current = this.#githubAnchorProjections.get(key);
    const refreshGeneration = (current?.refreshGeneration ?? 0) + 1;
    this.#githubAnchorProjections.set(key, {
      ...(current?.projection === undefined
        ? {}
        : { projection: structuredClone(current.projection) }),
      refreshGeneration,
    });
    return refreshGeneration;
  }

  async applyGithubAnchorProjectionRefresh(input: {
    anchor: GithubAnchorProjection['anchor'];
    generation: number;
    projection?: GithubAnchorProjection;
  }): Promise<boolean> {
    const key = taskKey(input.anchor);
    const current = this.#githubAnchorProjections.get(key);
    if (current?.refreshGeneration !== input.generation) return false;
    if (input.projection === undefined) {
      this.#githubAnchorProjections.set(key, {
        refreshGeneration: input.generation,
      });
      return true;
    }
    if (taskKey(input.projection.anchor) !== key) {
      throw new Error(
        'GitHub anchor refresh projection does not match its fence',
      );
    }
    this.#githubAnchorProjections.set(key, {
      projection: structuredClone(
        githubAnchorProjectionSchema.parse(input.projection),
      ),
      refreshGeneration: input.generation,
    });
    return true;
  }

  async readGithubAnchorProjection(
    anchor: GithubAnchorProjection['anchor'],
  ): Promise<GithubAnchorProjection | undefined> {
    const projection = this.#githubAnchorProjections.get(
      taskKey(anchor),
    )?.projection;
    return projection === undefined ? undefined : structuredClone(projection);
  }

  async listOpenGithubAnchorProjections(
    limit = 200,
  ): Promise<GithubAnchorProjection[]> {
    return structuredClone(
      [...this.#githubAnchorProjections.values()]
        .flatMap((entry) =>
          entry.projection === undefined ? [] : [entry.projection],
        )
        .filter((projection) => projection.state === 'open')
        .sort(
          (left, right) =>
            right.sourceUpdatedAt.localeCompare(left.sourceUpdatedAt) ||
            taskKey(right.anchor).localeCompare(taskKey(left.anchor)),
        )
        .slice(0, limit),
    );
  }

  async claimPendingOutbox(input: {
    limit: number;
    now: string;
    leaseExpiresAt: string;
    excludeEntryIds?: ReadonlySet<string>;
  }): Promise<LeasedOutboxEntry[]> {
    if (input.limit <= 0) return [];

    const now = Date.parse(input.now);
    const entries = [...this.#outbox.values()];
    const excluded = input.excludeEntryIds;
    const eligible = [
      ...entries.filter(
        (entry) =>
          entry.state === 'leased' && Date.parse(entry.leaseExpiresAt) <= now,
      ),
      // #1548 follow-up: a pending entry still backing off from its last
      // delivery failure (`nextAttemptAt` in the future) is skipped here,
      // the same as an explicitly excluded one -- see
      // `OrchestratorStore.claimPendingOutbox`'s doc comment. Sorted by
      // `byOutboxClaimFairness` (starvation fix) so a never-attempted
      // entry is never stuck behind an arbitrarily larger due-again,
      // already-failing set -- see that function's doc comment.
      ...entries
        .filter(
          (entry) =>
            entry.state === 'pending' &&
            !(excluded?.has(entry.entryId) ?? false) &&
            (entry.nextAttemptAt === undefined ||
              Date.parse(entry.nextAttemptAt) <= now),
        )
        .sort(byOutboxClaimFairness),
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
    state: 'pending' | 'done' | 'failed';
    now: string;
    firstFailedAt?: string;
    nextAttemptAt?: string;
    deliveryFailures?: number;
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
      // #1548 follow-up: omitted (`undefined`) leaves the field as `rest`
      // already carried it forward from `entry` -- only a caller settling
      // an actual delivery failure passes these.
      ...(input.firstFailedAt === undefined
        ? {}
        : { firstFailedAt: input.firstFailedAt }),
      ...(input.nextAttemptAt === undefined
        ? {}
        : { nextAttemptAt: input.nextAttemptAt }),
      ...(input.deliveryFailures === undefined
        ? {}
        : { deliveryFailures: input.deliveryFailures }),
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

  async listTasks(
    limit?: number,
    before?: TaskListCursor,
  ): Promise<VersionedTask[]> {
    const compare = (
      left: { key: string; updatedAt: string },
      right: { key: string; updatedAt: string },
    ) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.key.localeCompare(left.key);
    const cursor =
      before === undefined
        ? undefined
        : { key: before.taskKey, updatedAt: before.updatedAt };

    const tasks = [...this.#tasks.entries()]
      .map(([key, entry]) => ({ key, entry, updatedAt: entry.task.updatedAt }))
      .sort(compare)
      .filter((entry) => cursor === undefined || compare(entry, cursor) > 0)
      .slice(0, limit ?? 200)
      .map(({ entry }) => entry);
    return structuredClone(tasks);
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

  async listRecentRuns(limit: number): Promise<Run[]> {
    return structuredClone(
      [...this.#runs.values()]
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            right.runId.localeCompare(left.runId),
        )
        .slice(0, limit),
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

  async inventoryPersistedRecords(input: {
    kind: PersistedRecordKind;
    limit: number;
    cursor?: string;
  }): Promise<PersistedRecordPage> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > PERSISTED_MIGRATION_PAGE_MAX
    ) {
      throw new Error(
        `Persisted orchestrator inventory page size must be 1-${PERSISTED_MIGRATION_PAGE_MAX}`,
      );
    }
    const records = this.#migrationRecords(input.kind);
    const cursor =
      input.cursor === undefined
        ? undefined
        : decodePersistedMigrationCursor(input.cursor, input.kind);
    const cursorIndex =
      cursor === undefined
        ? undefined
        : records.findIndex(({ documentId }) => documentId === cursor);
    if (cursorIndex === -1)
      throw new PersistedMigrationCursorError(
        'Invalid persisted orchestrator inventory cursor',
      );
    const after = cursorIndex === undefined ? 0 : cursorIndex + 1;
    const page = records.slice(after, after + input.limit);
    const hasMore = records.length > after + page.length;
    return {
      kind: input.kind,
      consistency: 'page-only',
      records: page.map(({ documentId, value }) =>
        inventoryPersistedRecord(input.kind, value, documentId),
      ),
      hasMore,
      ...(hasMore && page.length > 0
        ? {
            nextCursor: encodePersistedMigrationCursor(
              input.kind,
              page.at(-1)?.documentId ?? '',
            ),
          }
        : {}),
    };
  }

  async previewPersistedMigration(
    entries: readonly PersistedMigrationEntry[],
  ): Promise<PersistedMigrationPreview> {
    const validated = validateManifest(entries);
    return {
      manifestId: manifestId(validated),
      entries: validated.length,
      deletions: validated
        .filter(isPersistedMigrationDeleteEntry)
        .map((entry) =>
          this.#deleteReadiness(entry, this.#migrationValue(entry.selector)),
        ),
    };
  }

  async applyPersistedMigration(input: {
    entries: readonly PersistedMigrationEntry[];
    reviewedManifestId: string;
  }): Promise<PersistedMigrationPreview> {
    const entries = validateManifest(input.entries);
    const id = manifestId(entries);
    if (id !== input.reviewedManifestId) {
      throw new PersistedMigrationConflict(
        'reviewed manifest id does not match the submitted entries',
      );
    }
    // Validate the complete bounded manifest before changing any map, the
    // in-memory equivalent of FirestoreStore's all-reads-before-writes
    // transaction. This makes the reference store useful for dry-run and
    // conflict tests without widening its normal API.
    const deletions: PersistedMigrationDeleteReadiness[] = [];
    for (const entry of entries) {
      const current = this.#migrationValue(entry.selector);
      if (current === undefined) {
        throw new PersistedMigrationConflict(
          `persisted ${entry.selector.kind} record disappeared`,
        );
      }
      if (fingerprint(current) !== entry.expectedFingerprint) {
        throw new PersistedMigrationConflict(
          `persisted ${entry.selector.kind} record changed after inventory`,
        );
      }
      if (isPersistedMigrationDeleteEntry(entry)) {
        const readiness = this.#deleteReadiness(entry, current);
        deletions.push(readiness);
        if (readiness.status === 'blocked') {
          throw new PersistedMigrationConflict(
            `persisted ${entry.selector.kind} deletion is blocked: ${readiness.reasons.join(',')}`,
          );
        }
      }
    }
    for (const entry of entries) {
      if (isPersistedMigrationDeleteEntry(entry)) {
        this.#deleteMigrationValue(entry);
      } else {
        this.#setMigrationValue(entry);
      }
    }
    return { manifestId: id, entries: entries.length, deletions };
  }

  #deleteReadiness(
    entry: PersistedMigrationDeleteEntry,
    current: TaskDocument | Run | OutboxEntry | undefined,
  ): PersistedMigrationDeleteReadiness {
    const reasons: PersistedMigrationDeleteBlockReason[] = [];
    if (current === undefined) {
      reasons.push('target-missing');
    } else if (fingerprint(current) !== entry.expectedFingerprint) {
      reasons.push('target-changed');
    } else if (
      !inventoryPersistedRecord(entry.selector.kind, current).findings.some(
        (finding) => finding.class === 'compatibility',
      )
    ) {
      reasons.push('no-compatibility-finding');
    }

    if (current !== undefined && entry.selector.kind === 'run') {
      const parsed = migrationRunSafetySchema.safeParse(current);
      if (!parsed.success) {
        reasons.push('invalid-run');
      } else if (!selectorMatchesRun(entry.selector, parsed.data.runId)) {
        reasons.push('invalid-run');
      } else {
        const run = parsed.data;
        if (isLive(run.state)) reasons.push('run-not-terminal');
        const parent = this.#tasks.get(taskKey(run.task));
        const parentSafety =
          parent === undefined
            ? undefined
            : migrationTaskSafetySchema.safeParse(parent);
        if (parentSafety !== undefined && !parentSafety.success) {
          reasons.push('invalid-parent-task');
        } else if (
          parentSafety !== undefined &&
          !migrationParentTaskMatchesRun(parentSafety.data.task.task, run.task)
        ) {
          reasons.push('invalid-parent-task');
        } else if (parentSafety?.data.task.activeRunId !== undefined) {
          reasons.push('parent-task-active');
        }
        const dependencies: OutboxEntry[] = [];
        for (const candidate of this.#outbox.values()) {
          if (candidate.runId !== run.runId) continue;
          dependencies.push(candidate);
          if (dependencies.length === 3) break;
        }
        const outboxStates = new Set(
          dependencies.map((candidate) => candidate.state),
        );
        if (outboxStates.has('pending')) reasons.push('pending-outbox');
        if (outboxStates.has('leased')) reasons.push('leased-outbox');
        if (dependencies.length === 3) {
          reasons.push('outbox-dependency-over-limit');
        }
      }
    }

    if (current !== undefined && entry.selector.kind === 'task') {
      const parsed = migrationTaskSafetySchema.safeParse(current);
      if (!parsed.success) {
        reasons.push('invalid-task');
      } else if (!selectorMatchesTask(entry.selector, parsed.data.task.task)) {
        reasons.push('invalid-task');
      } else {
        const task = parsed.data.task;
        if (task.activeRunId !== undefined) reasons.push('task-active');
        if (
          [...this.#runs.values()].some(
            (run) => taskKey(run.task) === taskKey(task.task),
          )
        ) {
          reasons.push('child-run-present');
        }
      }
    }

    if (current !== undefined && entry.selector.kind === 'outbox') {
      const parsed = migrationOutboxSafetySchema.safeParse(current);
      if (!parsed.success) {
        reasons.push('invalid-outbox');
      } else if (!selectorMatchesOutbox(entry.selector, parsed.data.entryId)) {
        reasons.push('invalid-outbox');
      } else if (
        parsed.data.state !== 'done' &&
        parsed.data.state !== 'failed'
      ) {
        reasons.push('outbox-not-terminal');
      }
    }

    return reasons.length === 0
      ? { selector: entry.selector, status: 'ready', reasons: [] }
      : { selector: entry.selector, status: 'blocked', reasons };
  }

  #migrationRecords(kind: PersistedRecordKind): {
    documentId: string;
    storageKey: string;
    value: TaskDocument | Run | OutboxEntry;
  }[] {
    const values =
      kind === 'task'
        ? [...this.#tasks.entries()].map(([key, value]) => ({
            documentId: encodeURIComponent(key),
            storageKey: key,
            value,
          }))
        : kind === 'run'
          ? [...this.#runs.entries()].map(([key, value]) => ({
              documentId: encodeURIComponent(key),
              storageKey: key,
              value,
            }))
          : [...this.#outbox.entries()].map(([key, value]) => ({
              documentId: encodeURIComponent(key),
              storageKey: key,
              value,
            }));
    return values.sort((left, right) =>
      left.documentId.localeCompare(right.documentId),
    );
  }

  #migrationValue(
    selector: PersistedRecordSelector,
  ): TaskDocument | Run | OutboxEntry | undefined {
    if ('address' in selector) {
      const documentId = decodePersistedMigrationAddress(
        selector.address,
        selector.kind,
      );
      return this.#migrationRecords(selector.kind).find(
        (record) => record.documentId === documentId,
      )?.value;
    }
    if (selector.kind === 'task')
      return this.#tasks.get(taskKey(selector.task));
    if (selector.kind === 'run') return this.#runs.get(selector.runId);
    return this.#outbox.get(selector.entryId);
  }

  #setMigrationValue(entry: PersistedMigrationEntry): void {
    if (isPersistedMigrationDeleteEntry(entry)) {
      throw new Error('delete entry cannot replace a persisted record');
    }
    if ('address' in entry.selector) {
      const documentId = decodePersistedMigrationAddress(
        entry.selector.address,
        entry.selector.kind,
      );
      const record = this.#migrationRecords(entry.selector.kind).find(
        (candidate) => candidate.documentId === documentId,
      );
      if (record === undefined) {
        throw new PersistedMigrationConflict(
          `persisted ${entry.selector.kind} record disappeared`,
        );
      }
      if (entry.selector.kind === 'task') {
        this.#tasks.set(
          record.storageKey,
          structuredClone(entry.replacement as TaskDocument),
        );
      } else if (entry.selector.kind === 'run') {
        this.#runs.set(
          record.storageKey,
          structuredClone(entry.replacement as Run),
        );
      } else {
        this.#outbox.set(
          record.storageKey,
          structuredClone(entry.replacement as OutboxEntry),
        );
      }
      return;
    }
    if (entry.selector.kind === 'task') {
      this.#tasks.set(
        taskKey(entry.selector.task),
        structuredClone(entry.replacement as TaskDocument),
      );
    } else if (entry.selector.kind === 'run') {
      this.#runs.set(
        entry.selector.runId,
        structuredClone(entry.replacement as Run),
      );
    } else {
      this.#outbox.set(
        entry.selector.entryId,
        structuredClone(entry.replacement as OutboxEntry),
      );
    }
  }

  #deleteMigrationValue(entry: PersistedMigrationDeleteEntry): void {
    const { selector } = entry;
    let storageKey: string;
    if ('address' in selector) {
      const record = this.#migrationRecords(selector.kind).find(
        (candidate) =>
          candidate.documentId ===
          decodePersistedMigrationAddress(selector.address, selector.kind),
      );
      if (record === undefined) {
        throw new PersistedMigrationConflict(
          `persisted ${selector.kind} record disappeared`,
        );
      }
      storageKey = record.storageKey;
    } else if (selector.kind === 'task') {
      storageKey = taskKey(selector.task);
    } else if (selector.kind === 'run') {
      storageKey = selector.runId;
    } else {
      storageKey = selector.entryId;
    }
    if (selector.kind === 'task') {
      this.#tasks.delete(storageKey);
      return;
    }
    if (selector.kind === 'outbox') {
      this.#outbox.delete(storageKey);
      return;
    }
    this.#runs.delete(storageKey);
    for (const [key, runId] of this.#requestRuns.entries()) {
      if (runId === storageKey) this.#requestRuns.delete(key);
    }
  }
}
