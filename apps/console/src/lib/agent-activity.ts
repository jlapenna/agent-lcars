import { parseDispatchMarker } from '@agent-lcars/dispatch-contracts';
import {
  isWorkAnchor,
  type OrchestratorStore,
  type Run as OrchestratorRun,
  type Task,
  taskKey,
  type VersionedTask,
} from '@agent-lcars/orchestrator';
import { workSpecSchema } from '@agent-lcars/work';

import {
  type AutoscalerScaleSetStatus,
  getAutoscalerStatuses,
} from './autoscaler-status';
import { repoItemKey, type WatchedRepo } from './github-client';
import { createOrchestratorRuntime } from './orchestrator-runtime';

// Re-exported from github-client.ts, which owns the server-side watched-repo
// boundary; the pure integration shape itself lives in watched-repo.ts.
export type { AgentPipeline } from './github-client';
import type { AgentPipeline } from './github-client';
// Direct executors share the same 90-minute run lease budget.
export const RUN_TIMEOUT_MINUTES = 90;

// Mirrors claude.yml's `--max-turns 200` claude_args. opencode.yml has no
// equivalent turn cap (its action takes no max_turns/max_steps input), so
// the turn-budget gauge only ever renders for `pipeline === 'claude'` runs -
// see LiveRunRow in agent-activity-panel.tsx.
export const MAX_TURNS_BUDGET = 200;

/** Exported so the panel can label the list as "last N" when it fills. */
export const RECENT_RUN_LIMIT = 8;
const ACTIVITY_TASK_LIMIT = 200;

export type AgentRunStatus = 'queued' | 'running' | 'completed';
export type AgentRunConclusion = 'success' | 'failure' | 'cancelled' | 'other';

export interface AgentRun {
  /** The exact orchestrator run id, suitable for telemetry joins. Legacy
   * numeric GitHub Actions ids remain accepted only for historical UI tests. */
  id: string | number;
  /** The anchor's repository (a GitHub anchor itself, or a native Work
   * item's declared target). It is presentation metadata, never runner
   * capacity or execution-state truth. */
  repo: WatchedRepo;
  /** The pipeline selected at admission and persisted on the run. */
  pipeline: AgentPipeline;
  status: AgentRunStatus;
  conclusion?: AgentRunConclusion;
  event: string;
  url: string;
  /** A derived operator label carrying the exact broker dispatch marker. */
  displayTitle: string;
  /** Present for GitHub anchors; absent for native Work. */
  issueNumber?: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Queued: seconds spent waiting for a runner. Running: seconds since the
   * run started. Completed: total run duration.
   */
  elapsedSeconds: number;
}

/** The server-owned autoscaler telemetry aggregate. Runners are ephemeral,
 * can scale to zero when idle, and have no useful repository affiliation. */
export interface FleetSummary {
  online: number;
  busy: number;
}

export interface AgentActivity {
  /** Every live (queued or running) authoritative broker run, with no
   * representative-attempt collapsing: #306 removed the
   * old "pick one representative attempt per (issue, pipeline) key and
   * silently drop the rest" behavior, since a duplicate dispatch (or a
   * genuine retry-in-flight) is exactly the kind of anomaly an operator
   * needs to see, not a rendering inconvenience to smooth over. Two attempts
   * racing the same repo/issue/pipeline both appear here; `logical-work.ts`'s
   * `deriveLogicalWork` is what groups them
   * into one `LogicalWork` card with a visible "N attempts" disclosure -
   * this field itself is the raw, ungrouped truth. */
  liveRuns: AgentRun[];
  recentRuns: AgentRun[];
  /** undefined = the authoritative runner telemetry read failed. */
  fleet?: FleetSummary;
  /** Lifecycle counts from authoritative Run records, never scale-set
   * telemetry. `claimed` remains pending until its executor starts it. */
  queue?: QueueRunSummary;
  /** Human-readable notes when a section above degraded instead of crashing. */
  warnings: string[];
}

/** Reduces the autoscaler's current-state projection once for the entire
 * fleet. It deliberately has no repository or provider input: scale-set
 * telemetry is the control plane's authoritative runner truth. */
export function fleetFromAutoscalerStatuses(
  statuses: readonly AutoscalerScaleSetStatus[],
): FleetSummary {
  let online = 0;
  let busy = 0;
  for (const status of statuses) {
    for (const runner of status.runners) {
      online += 1;
      if (runner.state === 'busy') busy += 1;
    }
  }
  return { online, busy };
}

export interface QueueRunSummary {
  queued: number;
  claimed: number;
  running: number;
}

/**
 * Counts direct-executor lifecycle state from broker Runs. Scale-set status
 * measures hosted-runner capacity and must not be used as queue occupancy.
 */
export function queueFromLiveRuns(
  runs: readonly OrchestratorRun[],
): QueueRunSummary {
  const summary: QueueRunSummary = { queued: 0, claimed: 0, running: 0 };
  for (const run of runs) {
    if (run.state === 'running') {
      summary.running += 1;
    } else if (run.state === 'pending' && run.queue?.state === 'claimed') {
      summary.claimed += 1;
    } else if (run.state === 'pending') {
      summary.queued += 1;
    }
  }
  return summary;
}

/**
 * The store deliberately pages task reads. Recent runs have no repository or
 * provider partition, so following that cursor is what keeps older anchors
 * from disappearing once the fleet exceeds one page.
 */
async function listAllActivityTasks(
  store: Pick<OrchestratorStore, 'listTasks'>,
): Promise<VersionedTask[]> {
  const tasks: VersionedTask[] = [];
  let before: { updatedAt: string; taskKey: string } | undefined;
  do {
    const page = await (before === undefined
      ? store.listTasks(ACTIVITY_TASK_LIMIT)
      : store.listTasks(ACTIVITY_TASK_LIMIT, before));
    tasks.push(...page);
    const last = page.at(-1);
    before =
      last === undefined
        ? undefined
        : {
            updatedAt: last.task.updatedAt,
            taskKey: taskKey(last.task.task),
          };
    if (page.length < ACTIVITY_TASK_LIMIT) return tasks;
  } while (before !== undefined);
  return tasks;
}

// One shape fleet-wide since #1340 A-R2. Before that, codex and opencode
// callers prefixed their own pipeline name ahead of the join key
// (`opencode #42: …`) and this regex carried an optional-prefix branch for
// them; the pipeline is already known from the fetch source, so the prefix
// was redundant everywhere it appeared.
const DISPLAY_TITLE_NUMBER_RE = /^#(\d+):/;

export function issueNumberFromDisplayTitle(
  displayTitle: string,
): number | undefined {
  const match = displayTitle.match(DISPLAY_TITLE_NUMBER_RE);
  return match ? Number(match[1]) : undefined;
}

/**
 * claude.yml/codex.yml/opencode.yml's `run-name` templates all append
 * `[dispatch:g<generation>:<intentId>]` after the `#<issue>:` join key -
 * the hosted orchestrator's own dispatch marker
 * (`orchestrator-dispatch.ts` mints the `broker_generation`/
 * `broker_intent_id` workflow-dispatch inputs — `intentId` is literally
 * the orchestrator run's own `runId` — and each workflow's `run-name`
 * template renders them into this exact string; the parse side is
 * `@agent-lcars/dispatch-contracts`' `parseDispatchMarker`).
 * Parsing it back out lets the console attribute a raw workflow run to the
 * exact dispatch generation/intent that dispatched it (see `logical-work.ts`'s
 * `toExecutionAttempt`) instead of only knowing the issue it worked.
 * Undefined for runs that predate the marker rollout, or any run dispatched
 * by hand outside it (a manual `workflow_dispatch` leaves the input blank,
 * which GitHub Actions renders as an empty `[dispatch:g:]`) - both cases
 * fall back to title/issue-number attribution only.
 */
export type AttemptMarker = NonNullable<ReturnType<typeof parseDispatchMarker>>;

/** Thin wrapper over the shared package's `parseDispatchMarker`, kept under
 * this name and signature because `tools/contract-tests/run-name-console-
 * join.test.ts` imports it directly to exercise this exact join. */
export function attemptMarkerFromDisplayTitle(
  displayTitle: string,
): AttemptMarker | undefined {
  return parseDispatchMarker(displayTitle);
}

/**
 * Direct link to the issue/PR a run worked, derived from its parsed
 * `issueNumber`. Always an `/issues/<N>` path - GitHub redirects that route
 * to `/pull/<N>` automatically when N is actually a PR, so one path covers
 * both kinds without the run needing to know which it is. Undefined for
 * runs that predate the run-name rollout (see `issueNumber`'s own doc) -
 * callers should fall back to the run's own title/url in that case.
 */
export function issueUrlForRun(run: AgentRun): string | undefined {
  return run.issueNumber === undefined
    ? undefined
    : `https://github.com/${run.repo.owner}/${run.repo.name}/issues/${run.issueNumber}`;
}

/**
 * A live run queued longer than this almost certainly means the autoscaler
 * isn't supplying it a runner - distinct from "zero runners registered",
 * which is a normal scaled-to-zero idle state on its own.
 */
export const QUEUE_STALL_THRESHOLD_SECONDS = 300;

/** The longest-stalled queued live run, if any - used to drive the queue
 * health warning (and its "queued for Xm" message). */
export function findStalledQueuedRun(
  liveRuns: AgentRun[],
): AgentRun | undefined {
  return liveRuns
    .filter(
      (run) =>
        run.status === 'queued' &&
        run.elapsedSeconds > QUEUE_STALL_THRESHOLD_SECONDS,
    )
    .sort((a, b) => b.elapsedSeconds - a.elapsedSeconds)[0];
}

/** One or more live runs clustered onto the same issue/PR - e.g. two
 * pipelines racing the same item, or a stray duplicate dispatch. */
export interface LiveRunGroup {
  /** `repoItemKey(repo, issueNumber)` for a run whose issue number parsed;
   * a synthetic `run-<id>` key for one that didn't (predates the run-name
   * rollout - see `AgentRun.issueNumber`'s own doc), so it still gets a
   * (singleton) group of its own instead of colliding with every other
   * unparsed run under one bucket. */
  key: string;
  issueNumber?: number;
  runs: AgentRun[];
}

/**
 * Clusters live runs by the issue/PR they're working, preserving each
 * group's and each run's first-seen order - the In Flight panel renders
 * runs racing the same item together instead of scattered across the flat
 * list (#239).
 */
export function groupLiveRunsByIssue(liveRuns: AgentRun[]): LiveRunGroup[] {
  const groups = new Map<string, LiveRunGroup>();
  for (const run of liveRuns) {
    const key =
      run.issueNumber === undefined
        ? `run-${run.id}`
        : repoItemKey(run.repo, run.issueNumber);
    const existing = groups.get(key);
    if (existing) {
      existing.runs.push(run);
    } else {
      groups.set(key, { key, issueNumber: run.issueNumber, runs: [run] });
    }
  }
  return Array.from(groups.values());
}

/**
 * The shared "is this a duplicate dispatch" rule: among the live
 * (queued/running) items in `runs`, group by pipeline and keep only the
 * groups with more than one member. Two independent renderers build their
 * own formatting on top of this one counting rule rather than each
 * re-deriving it - the task-detail anomaly list
 * (`logical-work.ts`'s `duplicateAttemptAnomalies`, one anomaly line per
 * duplicated pipeline with the run IDs named) and the home/agents page's "In
 * Flight" duplicate badge (`agent-activity-panel.tsx`'s
 * `duplicatePipelineSummary`, a short `"2 claude"`-style summary) - so a
 * future change to the rule itself (e.g. what counts as "live") only has to
 * happen once.
 *
 * Generic over `T extends AgentRun` so a caller passing `ExecutionAttempt[]`
 * (logical-work.ts) gets groups of `ExecutionAttempt` back, not a narrowed
 * `AgentRun[]` that would drop the extra fields its own formatting needs.
 */
export function duplicateLivePipelineGroups<T extends AgentRun>(
  runs: T[],
): Map<AgentPipeline, T[]> {
  const live = runs.filter(
    (run) => run.status === 'queued' || run.status === 'running',
  );
  const byPipeline = new Map<AgentPipeline, T[]>();
  for (const run of live) {
    const group = byPipeline.get(run.pipeline);
    if (group) group.push(run);
    else byPipeline.set(run.pipeline, [run]);
  }
  for (const [pipeline, group] of byPipeline) {
    if (group.length <= 1) byPipeline.delete(pipeline);
  }
  return byPipeline;
}

function repositoryFromTarget(targetRepo: string): WatchedRepo | undefined {
  const [owner, name, ...rest] = targetRepo.split('/');
  return owner && name && rest.length === 0 ? { owner, name } : undefined;
}

function generationFromRunId(runId: string): string {
  return runId.match(/\/r(\d+)$/u)?.[1] ?? '0';
}

function statusFor(run: OrchestratorRun): AgentRunStatus {
  return run.state === 'pending'
    ? 'queued'
    : run.state === 'running'
      ? 'running'
      : 'completed';
}

function conclusionFor(run: OrchestratorRun): AgentRunConclusion | undefined {
  if (run.state === 'finished') return run.result?.ok ? 'success' : 'failure';
  if (run.state === 'canceled') return 'cancelled';
  return run.state === 'lost' ? 'failure' : undefined;
}

/** Projects one durable run with its owning task's metadata. Invalid native
 * payloads are not guessed at: callers surface a single authoritative-data
 * warning and retain the rest of the fleet feed. */
export function agentRunFromOrchestrator(
  run: OrchestratorRun,
  task: Task,
  now = Date.now(),
): AgentRun | undefined {
  const status = statusFor(run);
  const elapsedSeconds = Math.max(
    0,
    Math.round(
      ((status === 'completed' ? Date.parse(run.updatedAt) : now) -
        Date.parse(run.createdAt)) /
        1000,
    ),
  );
  const generation = generationFromRunId(run.runId);
  const marker = `[dispatch:g${generation}:${run.runId}]`;

  if (!isWorkAnchor(run.task)) {
    const repo = repositoryFromTarget(run.task.repo);
    if (!repo) return undefined;
    const spec = workSpecSchema.safeParse(
      (task.work as Record<string, unknown> | undefined)?.['spec'],
    );
    const title = spec.success ? spec.data.title : `${run.pipeline} agent`;
    return {
      id: run.runId,
      repo,
      pipeline: run.pipeline as AgentPipeline,
      status,
      conclusion: conclusionFor(run),
      event: run.executor ?? 'github-actions',
      url: `https://github.com/${run.task.repo}/issues/${run.task.issue}`,
      displayTitle: `#${run.task.issue}: ${title} ${marker}`,
      issueNumber: run.task.issue,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      elapsedSeconds,
    };
  }

  const spec = workSpecSchema.safeParse(
    (task.work as Record<string, unknown> | undefined)?.['spec'],
  );
  if (!spec.success) return undefined;
  const repo = repositoryFromTarget(spec.data.target.repo);
  if (!repo) return undefined;
  return {
    id: run.runId,
    repo,
    pipeline: run.pipeline as AgentPipeline,
    status,
    conclusion: conclusionFor(run),
    event: run.executor ?? 'github-actions',
    url: `/work/${run.task.workId}`,
    displayTitle: `${spec.data.title} ${marker}`,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    elapsedSeconds,
  };
}

export async function getAgentActivity(): Promise<AgentActivity> {
  const { store } = createOrchestratorRuntime();

  const warnings: string[] = [];
  const [liveRead, taskRead, autoscalerRead] = await Promise.allSettled([
    store.listLiveRuns(),
    listAllActivityTasks(store),
    getAutoscalerStatuses(),
  ]);
  const autoscaler =
    autoscalerRead.status === 'fulfilled'
      ? autoscalerRead.value
      : { statuses: [], warnings: ['Runner autoscaler status unavailable.'] };

  if (liveRead.status === 'rejected') {
    console.error(
      'agent-lcars: failed to list authoritative live runs:',
      liveRead.reason,
    );
    warnings.push('Authoritative live run activity unavailable.');
  }
  if (taskRead.status === 'rejected') {
    console.error(
      'agent-lcars: failed to list authoritative recent runs:',
      taskRead.reason,
    );
    warnings.push('Authoritative recent run activity unavailable.');
  }

  const taskByKey = new Map(
    (taskRead.status === 'fulfilled' ? taskRead.value : []).map(({ task }) => [
      taskKey(task.task),
      task,
    ]),
  );
  const invalidMetadata = { value: false };
  const project = (run: OrchestratorRun, task: Task | undefined) => {
    if (task === undefined) {
      invalidMetadata.value = true;
      return undefined;
    }
    const projected = agentRunFromOrchestrator(run, task);
    if (projected === undefined) invalidMetadata.value = true;
    return projected;
  };

  const authoritativeLiveRuns =
    liveRead.status === 'fulfilled' ? liveRead.value : [];
  const liveRuns = (
    await Promise.all(
      authoritativeLiveRuns.map(async (run) => {
        const known = taskByKey.get(taskKey(run.task));
        if (known !== undefined) return project(run, known);
        try {
          return project(run, (await store.readTask(run.task))?.task);
        } catch (error) {
          console.error(
            'agent-lcars: failed to read authoritative live run task:',
            error,
          );
          invalidMetadata.value = true;
          return undefined;
        }
      }),
    )
  ).filter((run): run is AgentRun => run !== undefined);

  const recentSources = await Promise.all(
    (taskRead.status === 'fulfilled' ? taskRead.value : []).map(
      async ({ task }) => {
        try {
          return { task, runs: await store.listRuns(task.task) };
        } catch (error) {
          console.error(
            'agent-lcars: failed to read authoritative task runs:',
            error,
          );
          warnings.push('Authoritative recent run activity unavailable.');
          return undefined;
        }
      },
    ),
  );
  const recentRuns = recentSources
    .flatMap((source) =>
      source === undefined
        ? []
        : source.runs
            .filter((run) => run.state !== 'pending' && run.state !== 'running')
            .map((run) => project(run, source.task)),
    )
    .filter((run): run is AgentRun => run !== undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RECENT_RUN_LIMIT);
  if (invalidMetadata.value) {
    warnings.push('Authoritative run activity contains invalid task metadata.');
  }

  // A telemetry warning means the reader could not establish authoritative
  // fleet state, so do not turn that into a misleading zero-runner result.
  // Propagate its single fleet-level warning unchanged rather than emitting
  // one synthetic failure per watched repository.
  const fleet =
    autoscaler.warnings.length === 0
      ? fleetFromAutoscalerStatuses(autoscaler.statuses)
      : undefined;
  warnings.push(...autoscaler.warnings);

  return {
    liveRuns,
    recentRuns,
    fleet,
    queue: queueFromLiveRuns(authoritativeLiveRuns),
    warnings: Array.from(new Set(warnings)),
  };
}
