import {
  type RunEvidence,
  type TrackerIssue,
  type TrackerIssueDisplay,
  trackerIssueDisplay,
} from '@agent-lcars/dispatch-contracts';
import {
  type DeliveryBinding,
  type ProviderFallback,
  type Run,
  type Task,
  type TaskId,
  taskKey,
} from '@agent-lcars/orchestrator';
import {
  compareRunOrder,
  deriveItemState,
  type ItemState,
  latestRun,
} from '@agent-lcars/orchestrator';

import {
  storedWorkPayloadSchema,
  type StoredWorkSpec,
  type WorkOrigin,
  type WorkSpec,
} from './spec';

export { deriveItemState, type ItemState, latestRun };

export interface ItemRunView {
  issue?: TrackerIssueDisplay & Partial<TrackerIssue>;
  triagePublication?: Run['triagePublication'];
  runId: string;
  state: Run['state'];
  pipeline: string;
  priority?: WorkSpec['priority'];
  createdAt: string;
  updatedAt: string;
  result?: Run['result'];
  sourceRevision?: Run['sourceRevision'];
  revisionAttempt?: Run['revisionAttempt'];
  delivery?: DeliveryBinding;
  providerFallback?: Pick<
    ProviderFallback,
    | 'allowedPipelines'
    | 'attemptedPipelines'
    | 'originalRunId'
    | 'fromRunId'
    | 'trigger'
  >;
  queue?: {
    state: 'queued' | 'claimed' | 'retired';
    claimedBy?: string;
    claimedAt?: string;
    firstHeartbeatAt?: string;
    providerProcessStartedAt?: string;
    startDeadlineAt?: string;
    placement?: NonNullable<Run['queue']>['placement'];
  };
  /** The human turn that opened this round, for a `mode: reply` run.
   *  Round 1's human turn is `spec.description`, not a reply. */
  reply?: string;
  replyChannel?: string;
  replyPrincipal?: string;
  /** What the run's worker saw its agent do, on single-item reads of a run
   *  that reported any (`withRunEvidence`). Never derived from the run. */
  evidence?: RunEvidence;
}

export interface ItemSessionView {
  sessionId: string;
  runId: string;
  startedAt: string;
  lastActivityAt: string;
  title?: string;
  status?: string;
  transcriptGcsUri?: string;
}

export interface ItemView {
  id: string;
  state: ItemState;
  spec: StoredWorkSpec;
  origin: WorkOrigin;
  issue?: TrackerIssue;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  providerRouting?: Task['providerRouting'];
  runs: ItemRunView[];
  sessions: ItemSessionView[];
}

/**
 * The console's one projection shape for every durable task that carries a
 * valid work payload. Native items and GitHub-anchored work deliberately
 * share lifecycle truth here: their state is derived from the orchestrator
 * task and run history, never from a GitHub label or workflow-run title.
 *
 * `id` is `taskKey(anchor)`, so `work:<ulid>` and `owner/repo#number` live
 * in one collision-free cursor/link namespace while `anchor` retains the
 * typed route information a caller needs to choose its detail view.
 */
export interface WorkSummary {
  id: string;
  anchor: TaskId;
  state: ItemState;
  spec: StoredWorkSpec;
  origin: WorkOrigin;
  issue?: TrackerIssue;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  providerRouting?: Task['providerRouting'];
  runs: ItemRunView[];
}

export function workTitle(work: Pick<WorkSummary, 'spec' | 'issue'>): string {
  return work.issue
    ? `${work.issue.identifier}: ${work.issue.title}`
    : work.spec.title;
}

/** The public projection of one run, shared by the item view and the work
 *  summary. Copies every optional field only when present, so the two views
 *  stay key-for-key identical. The `reply*` human-turn fields are the item
 *  view's alone (`toItemView`). */
function toItemRunView(r: Run): ItemRunView {
  const issue = r.issueSnapshot;
  return {
    ...(issue === undefined ? {} : { issue: trackerIssueDisplay(issue) }),
    runId: r.runId,
    state: r.state,
    pipeline: r.pipeline,
    priority: r.priority ?? 'normal',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(r.result === undefined ? {} : { result: r.result }),
    ...(r.sourceRevision === undefined
      ? {}
      : {
          sourceRevision: r.sourceRevision,
          revisionAttempt: r.revisionAttempt,
        }),
    ...(r.delivery === undefined ? {} : { delivery: r.delivery }),
    ...(r.triagePublication === undefined
      ? {}
      : { triagePublication: r.triagePublication }),
    ...(r.providerFallback === undefined
      ? {}
      : {
          providerFallback: {
            allowedPipelines: [...r.providerFallback.allowedPipelines],
            attemptedPipelines: [...r.providerFallback.attemptedPipelines],
            originalRunId: r.providerFallback.originalRunId,
            ...(r.providerFallback.fromRunId === undefined
              ? {}
              : { fromRunId: r.providerFallback.fromRunId }),
            ...(r.providerFallback.trigger === undefined
              ? {}
              : { trigger: { ...r.providerFallback.trigger } }),
          },
        }),
    ...(r.queue === undefined
      ? {}
      : {
          queue: {
            state: r.queue.state,
            ...(r.queue.startDeadlineAt === undefined
              ? {}
              : { startDeadlineAt: r.queue.startDeadlineAt }),
            ...(r.queue.placement === undefined
              ? {}
              : { placement: r.queue.placement }),
            ...(r.queue.claimedAt === undefined
              ? {}
              : { claimedAt: r.queue.claimedAt }),
            ...(r.queue.firstHeartbeatAt === undefined
              ? {}
              : { firstHeartbeatAt: r.queue.firstHeartbeatAt }),
            ...(r.queue.providerProcessStartedAt === undefined
              ? {}
              : {
                  providerProcessStartedAt: r.queue.providerProcessStartedAt,
                }),
            ...(r.queue.claimedBy === undefined
              ? {}
              : { claimedBy: r.queue.claimedBy }),
          },
        }),
  };
}

/** The task-level fields both projections share, in the key order they
 *  always had. */
function toItemHeader(
  task: Task,
  runs: readonly Run[],
): Pick<
  WorkSummary,
  'state' | 'spec' | 'origin' | 'providerRouting' | 'createdAt' | 'updatedAt'
> &
  Partial<Pick<WorkSummary, 'closedAt' | 'issue'>> & { ordered: Run[] } {
  const payload = storedWorkPayloadSchema.parse(task.work);
  const ordered = [...runs].sort(compareRunOrder);
  return {
    state: deriveItemState(task, runs),
    spec: payload.spec,
    origin: payload.origin,
    ...(task.issue === undefined ? {} : { issue: task.issue }),
    ...(task.providerRouting === undefined
      ? {}
      : { providerRouting: task.providerRouting }),
    createdAt: ordered[0]?.createdAt ?? task.updatedAt,
    updatedAt: task.updatedAt,
    ...(task.closedAt === undefined ? {} : { closedAt: task.closedAt }),
    ordered,
  };
}

export function toItemView(input: {
  workId: string;
  task: Task;
  runs: readonly Run[];
  sessions?: readonly ItemSessionView[];
}): ItemView {
  const { ordered, ...header } = toItemHeader(input.task, input.runs);
  return {
    id: input.workId,
    ...header,
    runs: ordered.map((r) => ({
      ...toItemRunView(r),
      // The human turn that opened a `mode: reply` round -- round 1's is
      // `spec.description`, not on `params` at all.
      ...(r.params?.['reply'] === undefined
        ? {}
        : { reply: r.params['reply'] }),
      ...(r.params?.['replyChannel'] === undefined
        ? {}
        : { replyChannel: r.params['replyChannel'] }),
      ...(r.params?.['replyPrincipal'] === undefined
        ? {}
        : { replyPrincipal: r.params['replyPrincipal'] }),
    })),
    sessions: [...(input.sessions ?? [])],
  };
}

/** Projects any native or GitHub anchor with a valid `Task.work` payload. */
export function toWorkSummary(input: {
  task: Task;
  runs: readonly Run[];
}): WorkSummary {
  const { ordered, ...header } = toItemHeader(input.task, input.runs);
  return {
    id: taskKey(input.task.task),
    anchor: input.task.task,
    ...header,
    runs: ordered.map(toItemRunView),
  };
}
