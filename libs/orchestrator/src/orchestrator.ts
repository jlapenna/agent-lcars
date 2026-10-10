import {
  changeCredentialOperation,
  reserveCredentialOperation,
} from './credential-operation';
import {
  cancelRun,
  closeTask,
  confirmDispatch,
  decidedRun,
  type Decision,
  executorExitedAndRetry,
  type ExitClaimant,
  expireLeaseAndRetry,
  isRefusal,
  observePlacement,
  type Refusal,
  refused,
  renewLease,
  reportResult,
  requestRun,
  updateTaskWork,
} from './decide';
import {
  isLive,
  type ProviderFallbackRequest,
  type RequestSource,
  type Run,
  type RunResult,
  type Task,
  type TaskId,
  type WorkPayload,
} from './model';
import {
  providerCooldownForRun,
  providerIsCoolingDown,
} from './provider-cooldown';
import {
  reportResultWithFallback,
  rerouteQueuedRun,
  selectFallbackPipeline,
  settleProviderFallback,
} from './provider-fallback';
import {
  availableQueuePipelines,
  type OrchestratorStore,
  type RequestBinding,
  type RunTransactionState,
  StoreConflict,
  type VersionedTask,
} from './store';

type Decide<T extends Decision> = (
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

export interface ProviderFallbackAuthority {
  /** Server-known providers whose cooldown/occupancy are read transactionally. */
  readonly pipelines: readonly string[];
  /** Re-evaluates the request's authorizing principal and repository now. */
  allowedPipelines(task: Task, run: Run): readonly string[];
}

/**
 * Read → decide → apply, with one retry on a lost compare-and-set. The
 * decision layer is pure; this class is the only place I/O and time meet it.
 */
export interface RequestInput {
  taskId: TaskId;
  requestId: string;
  /** Omitted for arbitrary caller-controlled request IDs. */
  requestSource?: RequestSource;
  pipeline: string;
  params?: Record<string, string>;
  work?: WorkPayload;
  /** Constructed by the authenticated admission adapter, not a raw API field. */
  providerFallback?: ProviderFallbackRequest;
  /** Optional opaque atomic request binding. Its owner supplies the key and
   * canonical identity; the store records the first source request with the
   * request transaction rather than leaving a pre-request race to a caller. */
  requestBinding?: RequestBinding;
  /** Replace only this exact unclaimed queue attempt when changing provider.
   * Cancellation and admission share the request transaction and its claim fence. */
  replaceQueuedRunId?: string;
  /**
   * Called with an already-admitted Task's immutable Work while the request
   * transaction still owns its consistent snapshot. Returning false refuses
   * before request history or the live-run mutex can mint a Run against a
   * different Work specification.
   *
   * The orchestrator stores Work opaquely, so its owner supplies this
   * deterministic comparison rather than teaching the durable core a
   * caller-specific payload schema.
   */
  isStoredWorkCompatible?: (stored: WorkPayload, task: Task) => boolean;
}

export class Orchestrator {
  #rerouteOffset: number | undefined;
  constructor(
    private readonly store: OrchestratorStore,
    private readonly clock: Clock,
    private readonly fallbackAuthority?: ProviderFallbackAuthority,
  ) {}

  async request(input: RequestInput): Promise<Decision | Refusal> {
    // Firestore may replay a transaction callback after a concurrent commit;
    // capture time once so every replay evaluates the same pure request.
    const now = this.clock.now();
    const requestSource = input.requestSource ?? 'caller';
    return this.store.transactRequest({
      taskId: input.taskId,
      requestId: input.requestId,
      requestSource,
      ...(input.requestBinding === undefined
        ? {}
        : { requestBinding: input.requestBinding }),
      decide: ({ task, activeRun, previousRun, requestId }) => {
        // This belongs inside transactRequest, not in a route-level pre-read:
        // two first admissions may otherwise both observe an absent Task, and
        // the loser can mint its pipeline after the winner persists different
        // immutable Work. Firestore retries this callback with the winner's
        // snapshot, and MemoryStore applies it without yielding.
        if (
          task !== undefined &&
          input.isStoredWorkCompatible !== undefined &&
          !input.isStoredWorkCompatible(task.task.work, task.task)
        ) {
          return refused('work-spec-mismatch');
        }
        // The historical check precedes the live mutex. A retry remains a
        // duplicate even after its original run settled and a newer request
        // took the task lock; transactRequest keeps this check and minting
        // the replacement run in the same store transaction.
        if (previousRun !== undefined) {
          return refused('duplicate-request', previousRun);
        }
        const requestArgs = {
          now,
          taskId: input.taskId,
          requestId,
          requestSource,
          pipeline: input.pipeline,
          ...(input.params === undefined ? {} : { params: input.params }),
          ...(input.work === undefined ? {} : { work: input.work }),
          ...(input.providerFallback === undefined
            ? {}
            : { providerFallback: input.providerFallback }),
        };
        if (input.replaceQueuedRunId !== undefined) {
          if (
            task === undefined ||
            activeRun?.runId !== input.replaceQueuedRunId
          ) {
            return refused('stale-lease');
          }
          if (activeRun.queue?.state === 'claimed') {
            return refused('run-already-claimed');
          }
          if (
            activeRun.queue?.state !== 'queued' ||
            activeRun.pipeline === input.pipeline
          ) {
            return refused('task-busy');
          }
          const canceled = cancelRun({
            now,
            task: task.task,
            run: activeRun,
            note: `queued provider switch to ${input.pipeline}`,
          });
          if (isRefusal(canceled)) return canceled;
          const replacement = requestRun({
            ...requestArgs,
            task: canceled.task,
            activeRun: undefined,
          });
          if (isRefusal(replacement)) return replacement;
          return {
            ...replacement,
            additionalRuns: [decidedRun(canceled)],
            outbox: [...canceled.outbox, ...replacement.outbox],
          };
        }
        return requestRun({ ...requestArgs, task: task?.task, activeRun });
      },
    });
  }

  async confirmDispatch(runId: string): Promise<Decision | Refusal> {
    return this.transactOnRun(runId, (task, run) =>
      confirmDispatch({ now: this.clock.now(), task, run }),
    );
  }

  async renew(
    runId: string,
    claimFingerprint?: string,
    providerProcessStarted?: boolean,
  ): Promise<Decision | Refusal> {
    return this.transactOnRun(runId, (task, run) =>
      renewLease({
        now: this.clock.now(),
        task,
        run,
        providerProcessStarted,
        ...(claimFingerprint === undefined ? {} : { claimFingerprint }),
      }),
    );
  }

  async observePlacement(
    runId: string,
    claimant: ExitClaimant,
    placement: NonNullable<NonNullable<Run['queue']>['placement']>,
  ): Promise<Decision | Refusal> {
    return this.transactOnRun(runId, (task, run) =>
      observePlacement({
        now: this.clock.now(),
        task,
        run,
        claimant,
        placement,
      }),
    );
  }

  async report(
    runId: string,
    result: RunResult,
    claimFingerprint?: string,
    /** Server-owned cleanup identity, captured before the retryable transaction. */
    credentialCleanupId?: string,
  ): Promise<Decision | Refusal> {
    if (this.fallbackAuthority !== undefined && !result.ok) {
      return this.transactOnRun(
        runId,
        (task, run, queueEligibility) => {
          const decisionNow = this.clock.now();
          return reportResultWithFallback({
            now: decisionNow,
            task,
            run,
            result,
            ...(claimFingerprint === undefined ? {} : { claimFingerprint }),
            authorizedPipelines:
              this.fallbackAuthority?.allowedPipelines(task, run) ?? [],
            availablePipelines:
              queueEligibility === undefined
                ? []
                : availableQueuePipelines({
                    ...queueEligibility,
                    pipelines: this.fallbackAuthority?.pipelines ?? [],
                    now: decisionNow,
                  }),
          });
        },
        credentialCleanupId,
        {
          queueEligibilityPipelines: this.fallbackAuthority.pipelines,
          // Evaluate only after the consistent task/run read, before global
          // eligibility queries. Ordinary failures stay task-local.
          shouldReadQueueEligibility: ({ task, run }) =>
            task !== undefined &&
            run !== undefined &&
            task.task.activeRunId === run.runId &&
            (run.state === 'pending' || run.state === 'running') &&
            run.providerFallback !== undefined &&
            providerCooldownForRun({
              ...run,
              state: 'finished',
              result,
              updatedAt: this.clock.now(),
            }) !== undefined &&
            selectFallbackPipeline(
              run,
              this.fallbackAuthority?.allowedPipelines(task.task, run) ?? [],
              this.fallbackAuthority?.pipelines ?? [],
            ) !== undefined,
        },
      );
    }
    return this.transactOnRun(
      runId,
      (task, run) =>
        reportResult({
          now: this.clock.now(),
          task,
          run,
          result,
          ...(claimFingerprint === undefined ? {} : { claimFingerprint }),
        }),
      credentialCleanupId,
    );
  }

  /** Positive exact-sequence lease resolution and deferred fallback settlement
   * commit together. Recovery needs the reserved claim, not an active worker. */
  async finishCredentialOperation(input: {
    runId: string;
    operationId: string;
    claimFingerprint: string;
    restored?: boolean;
    leaseRetiredAtSequence?: number;
    now: () => string;
  }): Promise<Decision | Refusal> {
    const authority = this.fallbackAuthority;
    return this.store.transactRun({
      runId: input.runId,
      ...(authority === undefined
        ? {}
        : {
            queueEligibilityPipelines: authority.pipelines,
            shouldReadQueueEligibility: ({
              task,
              run,
            }: Pick<RunTransactionState, 'task' | 'run'>) =>
              task !== undefined &&
              run !== undefined &&
              task.task.activeRunId === run.runId &&
              run.credentialPendingResult !== undefined &&
              providerCooldownForRun({
                ...run,
                state: 'finished',
                result: run.credentialPendingResult.result,
                updatedAt: input.now(),
              }) !== undefined &&
              selectFallbackPipeline(
                run,
                authority.allowedPipelines(task.task, run),
                authority.pipelines,
              ) !== undefined,
          }),
      decide: ({ task, run, queueEligibility }) => {
        if (task === undefined || run === undefined)
          return refused('unknown-run');
        const now = input.now();
        const outcome = changeCredentialOperation({
          now,
          task: task.task,
          run,
          id: input.operationId,
          claimFingerprint: input.claimFingerprint,
          change: {
            kind: 'finish',
            ...(input.restored === undefined
              ? {}
              : { restored: input.restored }),
            ...(input.leaseRetiredAtSequence === undefined
              ? {}
              : { leaseRetiredAtSequence: input.leaseRetiredAtSequence }),
          },
        });
        if (
          isRefusal(outcome) ||
          authority === undefined ||
          run.credentialPendingResult === undefined
        )
          return outcome;
        return settleProviderFallback({
          now,
          settled: outcome,
          authorizedPipelines: authority.allowedPipelines(task.task, run),
          availablePipelines:
            queueEligibility === undefined
              ? []
              : availableQueuePipelines({
                  ...queueEligibility,
                  pipelines: authority.pipelines,
                  now,
                }),
        });
      },
    });
  }

  /** The executor's grant further narrows alternatives; only fresh unclaimed
   * attempts can be rerouted, never a live provider conversation. */
  async rerouteQueued(
    executorPipelines?: readonly string[],
    limit = 30,
  ): Promise<{ fromRunId: string; newRunId: string }[]> {
    const authority = this.fallbackAuthority;
    if (authority === undefined || !Number.isSafeInteger(limit) || limit <= 0)
      return [];
    const batchLimit = Math.min(limit, 30);
    const selectionTime = this.clock.now();
    const [queued, cooldowns] = await Promise.all([
      this.store.listQueuedRuns(),
      this.store.readProviderCooldowns(authority.pipelines),
    ]);
    // Healthy older requests must not consume the bounded reroute batch.
    // This prefilter grants no authority: the transaction rechecks cooldown,
    // exact run identity, current requester grants and provider occupancy.
    const candidates = queued.filter(
      (run) =>
        run.providerFallback !== undefined &&
        providerIsCoolingDown(cooldowns[run.pipeline], selectionTime) &&
        (run.queue?.deferredUntil === undefined ||
          run.queue.deferredUntil <= selectionTime),
    );
    if (candidates.length === 0) return [];
    // Rotate even on refusals. A minute-based initial slot also advances
    // cold instances; warm instances reserve their next batch before yielding.
    // This cursor changes scheduling only; every attempt is rechecked below.
    const offset =
      this.#rerouteOffset ??
      Math.floor(Date.parse(selectionTime) / 60_000) * batchLimit;
    const start =
      ((offset % candidates.length) + candidates.length) % candidates.length;
    const batch = Array.from(
      { length: Math.min(batchLimit, candidates.length) },
      (_, index) => candidates[(start + index) % candidates.length],
    );
    this.#rerouteOffset = start + batch.length;
    const rerouted: { fromRunId: string; newRunId: string }[] = [];
    for (const candidate of batch) {
      const now = this.clock.now();
      const outcome = await this.store.transactRun({
        runId: candidate.runId,
        queueEligibilityPipelines: authority.pipelines,
        decide: ({ task, run, queueEligibility }) => {
          if (
            task === undefined ||
            run === undefined ||
            queueEligibility === undefined
          )
            return refused('unknown-run');
          return rerouteQueuedRun({
            now,
            task: task.task,
            run,
            cooldown: queueEligibility.cooldowns[run.pipeline],
            authorizedPipelines: authority
              .allowedPipelines(task.task, run)
              .filter((pipeline) =>
                (executorPipelines ?? authority.pipelines).includes(pipeline),
              ),
            availablePipelines: availableQueuePipelines({
              ...queueEligibility,
              pipelines: authority.pipelines,
              now,
            }),
          });
        },
      });
      if (!isRefusal(outcome)) {
        const replacement = outcome.additionalRuns?.[0];
        if (replacement !== undefined)
          rerouted.push({
            fromRunId: candidate.runId,
            newRunId: replacement.runId,
          });
      }
    }
    return rerouted;
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
   * Cancel a run only while it has not been claimed by an executor and only
   * when it predates the lifecycle event requesting cancellation. The store
   * observes the run in the same transaction as the transition, fencing a
   * concurrent claim and a newer generation from stale close deliveries.
   */
  async cancelUnclaimedBefore(input: {
    runId: string;
    notAfter: string;
    note?: string;
  }): Promise<Decision | Refusal> {
    const now = this.clock.now();
    return this.store.transactRun({
      runId: input.runId,
      decide: ({ task, run }) => {
        if (task === undefined || run === undefined) {
          return refused('unknown-run');
        }
        if (run.queue?.state === 'claimed') {
          return refused('run-already-claimed');
        }
        if (Date.parse(run.createdAt) > Date.parse(input.notAfter)) {
          return refused('run-newer-than-cutoff');
        }
        return cancelRun({
          now,
          task: task.task,
          run,
          ...(input.note === undefined ? {} : { note: input.note }),
        });
      },
    });
  }

  async close(taskId: TaskId): Promise<Decision | Refusal> {
    return this.transact(taskId, async (task, activeRun) =>
      closeTask({ now: this.clock.now(), task: task?.task, activeRun }),
    );
  }

  async updateWork(
    taskId: TaskId,
    work: WorkPayload,
  ): Promise<Decision | Refusal> {
    return this.transact(taskId, async (task, activeRun) =>
      updateTaskWork({
        now: this.clock.now(),
        task: task?.task,
        activeRun,
        work,
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
   * The retry request uses a deterministic requestId (`retry:<lostRunId>`) in
   * its own internal history namespace,
   * so re-issuing it -- a re-sweep landing on the same run, or a caller
   * retrying after a crash -- maps to the run already created instead of
   * starting a second one; this is the same duplicate-request idempotency
   * `request()` already gives every caller, not a new mechanism.
   *
   * Loss settlement and retry creation are one store transaction. A crash
   * commits both or neither; repeated and concurrent sweeps therefore cannot
   * lose the retry or mint a duplicate.
   */
  async sweepExpired(): Promise<SweepResult> {
    const now = this.clock.now();
    const lost: Run[] = [];
    const retried: { lostRunId: string; newRunId: string }[] = [];
    for (const run of await this.store.listExpiredRuns(now)) {
      const outcome = await this.transactOnRun(run.runId, (task, current) =>
        expireLeaseAndRetry({ now: this.clock.now(), task, run: current }),
      );
      if (isRefusal(outcome)) continue;
      const settled = decidedRun(outcome);
      lost.push(settled);
      const retry = outcome.additionalRuns?.[0];
      if (retry !== undefined) {
        retried.push({ lostRunId: settled.runId, newRunId: retry.runId });
      }
    }
    return { lost, retried };
  }

  /**
   * The QueueExecutor reports that a claimed run's worker terminated. A run
   * still live at that point never reported its outcome, so it is settled
   * `lost` now -- with the same bounded auto-retry `sweepExpired` applies --
   * instead of holding its task until the two-hour lease runs out. A run
   * that already settled (the usual case: the worker reported, then exited)
   * is refused and left untouched, so reporting every exit is safe.
   */
  async executorExited(
    runId: string,
    claimant: ExitClaimant,
  ): Promise<Decision | Refusal> {
    return this.transactOnRun(runId, (task, run) =>
      executorExitedAndRetry({ now: this.clock.now(), task, run, claimant }),
    );
  }

  async #once<T extends Decision>(
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

  private async transact<T extends Decision = Decision>(
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
    decide: (
      task: VersionedTask['task'],
      run: Run,
      queueEligibility?: RunTransactionState['queueEligibility'],
    ) => Decision | Refusal,
    credentialCleanupId: string = crypto.randomUUID(),
    queueEligibilityOptions?: Pick<
      Parameters<OrchestratorStore['transactRun']>[0],
      'queueEligibilityPipelines' | 'shouldReadQueueEligibility'
    >,
  ): Promise<Decision | Refusal> {
    // Queue release/reclaim changes Run without advancing Task revision.
    // Decide against both documents inside the existing store transaction,
    // so a stale expiry/renewal/report cannot overwrite a fresh claim.
    return this.store.transactRun({
      runId,
      ...queueEligibilityOptions,
      decide: ({ task, run, queueEligibility }) => {
        if (task === undefined || run === undefined) {
          return { refused: true, reason: 'unknown-run' };
        }
        const outcome = decide(task.task, run, queueEligibility);
        if (
          isRefusal(outcome) ||
          !isLive(run.state) ||
          outcome.run === undefined ||
          isLive(outcome.run.state) ||
          run.pipeline !== 'codex' ||
          run.queue?.state !== 'claimed' ||
          run.queue.tokenHash === undefined ||
          outcome.run.credentialOperation !== undefined
        )
          return outcome;
        // Every accepted claimed-Codex terminal transition must retain exact
        // server cleanup authority before physical release. Keep the original
        // terminal Run, deterministic retry and outbox in this one Decision.
        // The ID is stable outside a retryable callback; the decided timestamp
        // follows the owning callback clock, never an earlier pre-read clock.
        const cleanup = reserveCredentialOperation({
          now: outcome.run.updatedAt,
          task: outcome.task,
          run: outcome.run,
          claimFingerprint: run.queue.tokenHash,
          id: credentialCleanupId,
          kind: 'cleanup',
        });
        if (isRefusal(cleanup)) return cleanup;
        return { ...outcome, run: cleanup.run };
      },
    });
  }
}
