import {
  assertCapacityPlacementClaim,
  assertCapacityWorkerPermit,
  type CapacityPlacementClaim,
  type CapacityRecord,
  capacityRecordForStorage,
  CapacityRefusal,
  type CapacityState,
  capacityStateForStorage,
  type CapacityWorkerPermit,
  emptyCapacityState,
  retiredKey,
} from './capacity-model';
import {
  claimQueuedRun,
  type Decision,
  isRefusal,
  type Refusal,
} from './decide';
import {
  type LifecycleMetricRead,
  type LifecycleMetricRecords,
  validateLifecycleMetricRead,
} from './lifecycle-metrics';
import type {
  GithubAnchorProjection,
  LeasedOutboxEntry,
  OutboxEntry,
  OutboxSettlement,
  RequestSource,
  Run,
  TaskId,
} from './model';
import {
  byOutboxClaimFairness,
  githubAnchorProjectionSchema,
  isLive,
  isWorkAnchor,
  requestHistoryKey,
  runRecoveryDeadline,
  settleOutboxEntry,
  taskKey,
} from './model';
import {
  type ProviderCooldown,
  providerCooldownForRun,
  providerIsCoolingDown,
} from './provider-cooldown';
import { retainsPhysicalClaim } from './provider-routing';
import {
  projectQueueAdmissionStatus,
  QUEUE_ADMISSION_READ_LIMIT,
} from './queue-admission-status';
import {
  type CapacityTransactionResult,
  type CapacityTransactionSnapshot,
  type OpenGithubAnchorProjectionCursor,
  type OpenGithubAnchorProjectionPage,
  type OrchestratorStore,
  PROVIDER_ROUTING_CLAIM_READ_LIMIT,
  queuePriorityTurnAfter,
  type RequestBinding,
  type RequestTransactionState,
  type RunTransactionState,
  selectFairQueuedRun,
  StoreConflict,
  type TaskListCursor,
  type VersionedTask,
} from './store';

/** Reference implementation; also the test double. */
export class MemoryStore implements OrchestratorStore {
  #capacity: CapacityState = emptyCapacityState();
  readonly #capacityRecords = new Map<string, CapacityRecord>();
  readonly #tasks = new Map<string, VersionedTask>();
  readonly #providerCooldowns = new Map<string, ProviderCooldown>();
  readonly #priorityPositions = new Map<string, number>();
  readonly #runs = new Map<string, Run>();
  readonly #requestRuns = new Map<string, string>();
  readonly #requestBindings = new Map<
    string,
    { canonicalRequestId: string; firstSourceRequestId: string }
  >();
  readonly #outbox = new Map<string, OutboxEntry>();
  readonly #githubAnchorProjections = new Map<
    string,
    { projection?: GithubAnchorProjection; refreshGeneration: number }
  >();

  async transactCapacity<T>(input: {
    now: string;
    recordKeys: readonly string[];
    claimPipelines?: readonly string[];
    runId?: string;
    readRunIds?: readonly string[];
    decide(snapshot: CapacityTransactionSnapshot): CapacityTransactionResult<T>;
  }): Promise<T> {
    // No await between snapshot and commit: the same race boundary as claim.
    const runs = [...this.#runs.values()].filter((run) =>
      input.claimPipelines !== undefined
        ? run.queue?.state === 'queued' ||
          run.queue?.state === 'claimed' ||
          input.readRunIds?.includes(run.runId) === true ||
          this.#capacity.receipts.some((receipt) => receipt.runId === run.runId)
        : run.runId === input.runId ||
          input.readRunIds?.includes(run.runId) === true,
    );
    if (runs.length > 1000)
      throw new Error('Capacity run inventory exceeds read bound');
    const keys = new Set([
      ...input.recordKeys,
      ...runs.map((run) => retiredKey(run.runId)),
    ]);
    const records = new Map<string, CapacityRecord>();
    for (const key of keys) {
      const record = this.#capacityRecords.get(key);
      if (record !== undefined) records.set(key, structuredClone(record));
    }
    const result = input.decide({
      state: structuredClone(this.#capacity),
      records,
      runs: structuredClone(runs),
      priorityPositions: new Map(this.#priorityPositions),
      coolingPipelines: new Set(
        [...this.#providerCooldowns.entries()]
          .filter(([, value]) => providerIsCoolingDown(value, input.now))
          .map(([key]) => key),
      ),
    });
    const state =
      result.state === undefined
        ? undefined
        : capacityStateForStorage(result.state);
    const writes = [...(result.records ?? [])].map(
      ([key, record]) => [key, capacityRecordForStorage(record)] as const,
    );
    if (state !== undefined) this.#capacity = state;
    for (const [key, record] of writes)
      this.#capacityRecords.set(key, structuredClone(record));
    if (result.run !== undefined)
      this.#runs.set(result.run.runId, structuredClone(result.run));
    if (result.priorityTurn !== undefined)
      this.#priorityPositions.set(
        result.priorityTurn.pipeline,
        result.priorityTurn.position,
      );
    return structuredClone(result.value);
  }

  async readTask(id: TaskId): Promise<VersionedTask | undefined> {
    return structuredClone(this.#tasks.get(taskKey(id)));
  }

  async readLifecycleMetricRecords(
    input: LifecycleMetricRead,
  ): Promise<LifecycleMetricRecords> {
    validateLifecycleMetricRead(input);
    const runs = [...this.#runs.values()];
    const recent = runs
      .filter(
        (run) => run.updatedAt >= input.since && run.updatedAt <= input.until,
      )
      .slice(0, input.limit + 1);
    const live = runs
      .filter((run) => isLive(run.state))
      .slice(0, input.limit + 1);
    const outbox = [...this.#outbox.values()]
      .filter((entry) => entry.state !== 'done')
      .slice(0, input.limit + 1);
    return structuredClone({
      recentRuns: recent.slice(0, input.limit),
      liveRuns: live.slice(0, input.limit),
      outstandingOutbox: outbox.slice(0, input.limit),
      complete: [recent, live, outbox].every(
        (feed) => feed.length <= input.limit,
      ),
    });
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
    requestBinding?: RequestBinding;
    readProviderRouting?: boolean;
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
    const binding =
      input.requestBinding === undefined
        ? undefined
        : this.#requestBindings.get(
            this.#bindingKey(input.taskId, input.requestBinding.bindingKey),
          );
    const { requestId, nextBinding } = this.#resolveRequestBinding({
      requestId: input.requestId,
      binding: input.requestBinding,
      current: binding,
    });
    const previousRunId = this.#requestRuns.get(
      this.#requestKey(input.taskId, input.requestSource, requestId),
    );
    const previousRun =
      previousRunId === undefined
        ? undefined
        : structuredClone(this.#runs.get(previousRunId));
    const claimedCandidates =
      input.readProviderRouting && task !== undefined
        ? [...this.#runs.values()].filter(
            (run) =>
              taskKey(run.task) === key && run.queue?.state === 'claimed',
          )
        : undefined;
    const outcome = input.decide({
      task,
      activeRun,
      requestId,
      previousRun,
      ...(input.readProviderRouting && task !== undefined
        ? {
            latestRun:
              task === undefined
                ? undefined
                : structuredClone(
                    this.#runs.get(`${key}/r${task.task.runCount}`),
                  ),
            capacityReceiptRunIds: this.#capacity.receipts
              .filter(
                (receipt) =>
                  receipt.taskKey === undefined || receipt.taskKey === key,
              )
              .map((receipt) => receipt.runId),
            // Incomplete inventory is durable refusal evidence, not a retryable error.
            retainedClaims:
              claimedCandidates !== undefined &&
              claimedCandidates.length <= PROVIDER_ROUTING_CLAIM_READ_LIMIT
                ? structuredClone(
                    claimedCandidates.filter((run) =>
                      retainsPhysicalClaim(run, this.#capacity),
                    ),
                  )
                : undefined,
          }
        : {}),
    });
    if (nextBinding !== undefined && input.requestBinding !== undefined) {
      this.#requestBindings.set(
        this.#bindingKey(input.taskId, input.requestBinding.bindingKey),
        nextBinding,
      );
    }
    if (isRefusal(outcome)) return outcome;
    this.#apply({ decision: outcome, expectedRevision: task?.revision });
    return outcome;
  }

  async transactRun(input: {
    runId: string;
    placementClaim?: CapacityPlacementClaim;
    workerPermit?: CapacityWorkerPermit;
    queueEligibilityPipelines?: readonly string[];
    shouldReadQueueEligibility?: (
      state: Pick<RunTransactionState, 'task' | 'run'>,
    ) => boolean;
    decide(state: RunTransactionState): Decision | Refusal;
  }): Promise<Decision | Refusal> {
    // Keep the snapshot and write synchronous, matching `transactRequest`'s
    // reference transaction semantics.
    if (input.workerPermit !== undefined) {
      if (input.workerPermit.runId !== input.runId)
        throw new CapacityRefusal('worker');
      assertCapacityWorkerPermit(
        this.#capacity,
        this.#capacityRecords.get(retiredKey(input.runId)),
        input.workerPermit,
      );
    }
    if (input.placementClaim !== undefined) {
      if (input.placementClaim.runId !== input.runId)
        throw new CapacityRefusal('authority');
      assertCapacityPlacementClaim(
        this.#capacity,
        this.#capacityRecords.get(retiredKey(input.runId)),
        input.placementClaim,
      );
    }
    const run = structuredClone(this.#runs.get(input.runId));
    const task =
      run === undefined
        ? undefined
        : structuredClone(this.#tasks.get(taskKey(run.task)));
    const outcome = input.decide({
      task,
      run,
      ...(input.queueEligibilityPipelines === undefined ||
      input.shouldReadQueueEligibility?.({ task, run }) === false
        ? {}
        : {
            queueEligibility: {
              cooldowns: Object.fromEntries(
                input.queueEligibilityPipelines.map((pipeline) => [
                  pipeline,
                  structuredClone(this.#providerCooldowns.get(pipeline)),
                ]),
              ),
              liveRuns: structuredClone(
                [...this.#runs.values()].filter((candidate) =>
                  input.queueEligibilityPipelines?.includes(candidate.pipeline),
                ),
              ),
            },
          }),
    });
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
          decision.run.requestSource,
          decision.run.requestId,
        ),
        decision.run.runId,
      );
    }
    for (const run of decision.additionalRuns ?? []) {
      this.#runs.set(run.runId, structuredClone(run));
      this.#requestRuns.set(
        this.#requestKey(run.task, run.requestSource, run.requestId),
        run.runId,
      );
    }
    for (const run of [decision.run, ...(decision.additionalRuns ?? [])]) {
      if (run === undefined) continue;
      const cooldown = providerCooldownForRun(run);
      if (cooldown !== undefined)
        this.#providerCooldowns.set(cooldown.pipeline, cooldown);
    }
    for (const entry of decision.outbox) {
      this.#outbox.set(entry.entryId, structuredClone(entry));
    }
  }

  #requestKey(id: TaskId, source: RequestSource, requestId: string): string {
    return JSON.stringify([taskKey(id), requestHistoryKey(source, requestId)]);
  }

  #bindingKey(id: TaskId, bindingKey: string): string {
    return JSON.stringify([taskKey(id), bindingKey]);
  }

  #resolveRequestBinding(input: {
    requestId: string;
    binding?: RequestBinding;
    current?: { canonicalRequestId: string; firstSourceRequestId: string };
  }): {
    requestId: string;
    nextBinding?: { canonicalRequestId: string; firstSourceRequestId: string };
  } {
    if (input.binding === undefined) return { requestId: input.requestId };
    const { binding } = input;
    if (input.current === undefined) {
      return {
        requestId: binding.canonicalRequestId,
        nextBinding: {
          canonicalRequestId: binding.canonicalRequestId,
          firstSourceRequestId: input.requestId,
        },
      };
    }
    if (input.current.canonicalRequestId !== binding.canonicalRequestId) {
      throw new Error('request binding canonical identity mismatch');
    }
    return {
      requestId:
        input.current.firstSourceRequestId === input.requestId
          ? binding.canonicalRequestId
          : input.requestId,
    };
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
    return this.#sortedOpenGithubAnchorProjections().slice(0, limit);
  }

  async listOpenGithubAnchorProjectionPage(input: {
    limit: number;
    cursor?: OpenGithubAnchorProjectionCursor;
  }): Promise<OpenGithubAnchorProjectionPage> {
    const all = this.#sortedOpenGithubAnchorProjections();
    const cursor = input.cursor;
    const cursorIndex =
      cursor === undefined
        ? -1
        : all.findIndex(
            (projection) =>
              cursor.sourceUpdatedAt.localeCompare(projection.sourceUpdatedAt) >
                0 ||
              (cursor.sourceUpdatedAt === projection.sourceUpdatedAt &&
                taskKey(cursor.anchor).localeCompare(
                  taskKey(projection.anchor),
                ) > 0),
          );
    // A projection can be refreshed between pages.  Treat the opaque cursor
    // as an ordering boundary rather than requiring its old snapshot to
    // still exist, exactly like Firestore's startAfter values do.
    const start =
      cursor === undefined ? 0 : cursorIndex === -1 ? all.length : cursorIndex;
    const projections = all.slice(start, start + input.limit);
    const last = projections.at(-1);
    return {
      projections,
      ...(last !== undefined && start + input.limit < all.length
        ? {
            nextCursor: {
              sourceUpdatedAt: last.sourceUpdatedAt,
              anchor: structuredClone(last.anchor),
            },
          }
        : {}),
    };
  }

  #sortedOpenGithubAnchorProjections(): GithubAnchorProjection[] {
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
        ),
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

  async settleOutbox(input: OutboxSettlement): Promise<boolean> {
    const settled = settleOutboxEntry(this.#outbox.get(input.entryId), input);
    if (settled === undefined) return false;
    this.#outbox.set(input.entryId, settled);
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
      (await this.listLiveRuns()).filter((run) => {
        const deadline = runRecoveryDeadline(run);
        return deadline !== undefined && Date.parse(deadline) <= cutoff;
      }),
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

  async readQueueAdmissionStatus(input: {
    pipelines: readonly string[];
    now: string;
  }) {
    const runs = [...this.#runs.values()].filter((run) => isLive(run.state));
    for (const state of ['pending', 'running']) {
      if (
        runs.filter((run) => run.state === state).length >
        QUEUE_ADMISSION_READ_LIMIT
      )
        throw new Error('Queue admission snapshot exceeds read bound');
    }
    return structuredClone(
      projectQueueAdmissionStatus(
        runs,
        this.#providerCooldowns,
        input.pipelines,
        input.now,
      ),
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

  async listCredentialOperations(input: {
    now: string;
    limit: number;
  }): Promise<Run[]> {
    return structuredClone(
      [...this.#runs.values()]
        .flatMap((run) => {
          const operation = run.credentialOperation;
          return operation !== undefined && operation.recoverAfter <= input.now
            ? [{ run, recoverAfter: operation.recoverAfter }]
            : [];
        })
        .sort(
          (a, b) =>
            a.recoverAfter.localeCompare(b.recoverAfter) ||
            a.run.runId.localeCompare(b.run.runId),
        )
        .slice(0, input.limit)
        .map((candidate) => candidate.run),
    );
  }

  async claimQueuedRun(input: {
    pipelines: readonly string[];
    now: string;
    claimedBy: string;
    claimedBySubject?: string;
    tokenHash: string;
    placementAware?: boolean;
  }): Promise<Run | undefined> {
    if (
      this.#capacity.policies.some(
        (policy) =>
          policy.enforced &&
          input.pipelines.some(
            (pipeline) => policy.domains[pipeline] !== undefined,
          ),
      )
    ) {
      throw new CapacityRefusal('policy');
    }
    const runs = [...this.#runs.values()];
    const eligible = input.pipelines.filter(
      (pipeline) =>
        !providerIsCoolingDown(
          this.#providerCooldowns.get(pipeline),
          input.now,
        ),
    );
    const candidate = selectFairQueuedRun(
      runs,
      runs,
      eligible,
      input.now,
      this.#priorityPositions,
    );
    if (candidate === undefined) return undefined;
    const claimed = claimQueuedRun(candidate, input);
    this.#runs.set(candidate.runId, claimed);
    this.#priorityPositions.set(
      candidate.pipeline,
      queuePriorityTurnAfter(
        this.#priorityPositions.get(candidate.pipeline) ?? 0,
        candidate.priority ?? 'normal',
      ),
    );
    return structuredClone(claimed);
  }

  async releaseQueuedRunClaim(input: {
    runId: string;
    claimedBy: string;
    tokenHash: string;
    now: string;
    deferredUntil?: string;
  }): Promise<boolean> {
    if (
      this.#capacity.receipts.some((receipt) => receipt.runId === input.runId)
    )
      return false;
    const run = this.#runs.get(input.runId);
    if (
      run !== undefined &&
      this.#capacity.policies.some(
        (policy) =>
          policy.enforced && policy.domains[run.pipeline] !== undefined,
      )
    )
      return false;
    if (
      run === undefined ||
      !isLive(run.state) ||
      run.credentialOperation !== undefined ||
      run.queue?.state !== 'claimed' ||
      run.queue.claimedBy !== input.claimedBy ||
      run.queue.tokenHash !== input.tokenHash
    ) {
      return false;
    }
    this.#runs.set(run.runId, {
      ...run,
      queue: {
        state: 'queued',
        ...(input.deferredUntil === undefined
          ? {}
          : { deferredUntil: input.deferredUntil }),
      },
      updatedAt: input.now,
    });
    return true;
  }

  async listQueuedRuns(limit?: number): Promise<Run[]> {
    return structuredClone(
      [...this.#runs.values()]
        .filter((run) => run.queue?.state === 'queued' && isLive(run.state))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit),
    );
  }
  async readProviderCooldowns(
    pipelines: readonly string[],
  ): Promise<Readonly<Record<string, unknown>>> {
    return Object.fromEntries(
      pipelines.map((pipeline) => [
        pipeline,
        structuredClone(this.#providerCooldowns.get(pipeline)),
      ]),
    );
  }
}
