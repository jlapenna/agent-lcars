import {
  type DispatchOutcomeKind,
  formatAttemptId,
} from '@agent-lcars/dispatch-contracts';

import {
  type AgentPipeline,
  type AgentRun,
  attemptMarkerFromDisplayTitle,
  duplicateLivePipelineGroups,
  type FleetSummary,
} from './agent-activity';
import {
  repoItemKey,
  type TaskRef,
  taskRefKey,
  taskRefUrl,
} from './watched-repo';

/**
 * The console's authoritative view models for #306 - see
 * agent-lcars#306/agent-lcars#301 for the full design. Two concepts that
 * used to be conflated into "a live run row":
 *
 * - `LogicalWork`: one canonical task (`TaskRef` - repo + issue number,
 *   never a title or a run ID). What an operator actually wants to reason
 *   about: "what is happening with issue #42."
 * - `ExecutionAttempt`: one GitHub Actions workflow run. A task may have
 *   zero attempts (nothing dispatched yet), one normal attempt, or
 *   more than one (a genuine anomaly this model surfaces, never hides).
 *
 * `deriveLogicalWork` is the one pure join every page renders from - Command
 * Deck, Agents, and the task detail page all call it instead of each
 * re-deriving their own notion of "what's happening with this issue."
 */

export type LogicalWorkState =
  | 'unavailable'
  | 'dispatching'
  | 'active'
  | 'human-needed'
  | 'completed'
  | 'anomaly'
  | 'unknown';

export type AttemptAttribution =
  'orchestrator' | 'run-marker' | 'legacy-title' | 'unattributed';

/** One GitHub Actions workflow run, enriched with whatever dispatch
 * lineage could be attributed to it. Every field `AgentRun` already carries
 * is still here (this is a superset, not a projection) - nothing about the
 * underlying run is lost by wrapping it. */
export interface ExecutionAttempt extends AgentRun {
  generation?: number;
  intentId?: string;
  /** The attempt's stable identity, `g<generation>:<intentId>` (#645) - one
   * field a consumer can key or link on instead of recomposing the pair
   * itself. Populated in lockstep with `generation`/`intentId` above: never
   * set when either of those is undefined, always set when both are. */
  attemptId?: string;
  /** How confidently `generation`/`intentId` are known:
   * - `orchestrator`: the run's `[dispatch:gN:intentId]` marker matched a
   *   real `@agent-lcars/orchestrator` run (see task-detail.ts's own
   *   `attributeAttemptsToOrchestrator`) - the strongest evidence this
   *   vocabulary can offer.
   * - `run-marker`: the marker parsed, but no orchestrator run was
   *   available to corroborate it (older issue, read failed/degraded).
   * - `legacy-title`: only the leading `#N:` join key parsed - the run
   *   predates the dispatch marker rollout.
   * - `unattributed`: no issue number parsed at all. */
  attribution: AttemptAttribution;
  /** Orchestrator-owned lifecycle result for this exact bound run, distinct
   * from the coarse GitHub Actions conclusion. */
  outcome?: DispatchOutcomeKind;
}

export interface LogicalWorkAnomaly {
  kind: 'duplicate-active-attempts' | 'attempt-ledger-mismatch';
  detail: string;
}

/** `authoritative-v1` when `@agent-lcars/orchestrator`'s own task state
 * backs this task (see task-detail.ts's `applyOrchestratorTruth`, which
 * overlays it - `deriveLogicalWork` itself only ever produces the other
 * two); `legacy` when only run attempts (marker or bare title parse) are
 * known; `unavailable` when the authoritative read genuinely failed. */
export type LogicalWorkProvenance =
  | { kind: 'authoritative-v1'; revision: number }
  | { kind: 'legacy' }
  | { kind: 'unavailable' };

export interface LogicalWork {
  task: TaskRef;
  title: string;
  url: string;
  selectedPipeline?: AgentPipeline;
  state: LogicalWorkState;
  /** Every workflow run attributed to this task, oldest first. Never
   * shrunk by grouping - a duplicate/retry keeps every attempt visible. */
  attempts: ExecutionAttempt[];
  anomalies: LogicalWorkAnomaly[];
  provenance: LogicalWorkProvenance;
}

/** Bare title/url metadata for a task, independent of whether it currently
 * has any live or recent attempts - the open-item board (action-items.ts)
 * is the usual source, but any caller with a title/url pair for a task can
 * supply one (e.g. a future closed-item detail fetch). */
export interface TaskMeta {
  repo: TaskRef['repository'];
  issueNumber: number;
  title: string;
  url: string;
  /** Mirrors `ActionItem.actionTypes.includes('needs-human')` - a maintainer
   * decision is blocking progress regardless of what the attempts say, so it
   * outranks a merely-active/pending dispatch state (see
   * `LOGICAL_STATE_PRIORITY`) but never masks a genuine attempt anomaly. */
  humanNeeded?: boolean;
}

const LOGICAL_STATE_PRIORITY: Record<LogicalWorkState, number> = {
  unavailable: 0,
  anomaly: 0,
  'human-needed': 1,
  active: 2,
  dispatching: 3,
  completed: 5,
  unknown: 6,
};

/** State derived from the raw attempts alone (any running/queued attempt
 * means work is in flight) - the orchestrator's own richer task state is
 * overlaid separately on the task detail page (see task-detail.ts's
 * `applyOrchestratorTruth`). */
function stateFromAttempts(attempts: ExecutionAttempt[]): LogicalWorkState {
  if (attempts.some((a) => a.status === 'running')) return 'active';
  if (attempts.some((a) => a.status === 'queued')) return 'dispatching';
  if (attempts.length > 0) return 'completed';
  return 'unknown';
}

function toExecutionAttempt(run: AgentRun): ExecutionAttempt {
  const marker = attemptMarkerFromDisplayTitle(run.displayTitle);
  if (marker) {
    return {
      ...run,
      generation: marker.generation,
      intentId: marker.intentId,
      // The marker IS `formatAttemptId(marker)` in brackets (see marker.ts),
      // so re-deriving it here from the same parsed pair is exact, not a
      // guess.
      attemptId: formatAttemptId(marker),
      attribution: 'run-marker',
    };
  }
  return {
    ...run,
    attribution:
      run.issueNumber === undefined ? 'unattributed' : 'legacy-title',
  };
}

/** Same-pipeline duplicates are the anomaly worth calling out explicitly -
 * two different pipelines racing the same issue is already a distinct,
 * intentional condition the UI shows separately (see
 * agent-activity-panel.tsx's cross-pipeline grouping), not a dispatch bug. */
function duplicateAttemptAnomalies(
  attempts: ExecutionAttempt[],
): LogicalWorkAnomaly[] {
  const anomalies: LogicalWorkAnomaly[] = [];
  for (const [pipeline, group] of duplicateLivePipelineGroups(attempts)) {
    anomalies.push({
      kind: 'duplicate-active-attempts',
      detail: `${group.length} ${pipeline} attempts are queued or running for the same task at once (run ${group.map((a) => a.id).join(', ')}).`,
    });
  }
  return anomalies;
}

export interface DeriveLogicalWorkInput {
  /** Raw workflow runs (live and/or recent) for every watched repo -
   * ungrouped, exactly as `agent-activity.ts` fetches them. */
  attempts: AgentRun[];
  /** Reads that failed. These tasks render an explicit unavailable state
   * and never fall back to attempts or comment-derived lifecycle truth. */
  unavailableTaskKeys?: ReadonlySet<string>;
  /** Title/url metadata keyed by `repoItemKey(repo, issueNumber)` - normally
   * every open board item, so a task with attempts but no open-item metadata
   * still renders (title falls back to the run's own display title). */
  taskMeta: Map<string, TaskMeta>;
}

export interface DeriveLogicalWorkResult {
  work: LogicalWork[];
  /** Attempts whose issue number could not be parsed at all (predate the
   * run-name rollout). These have no safe `TaskRef` to attach to, so they
   * are never folded into a `LogicalWork` by guesswork (e.g. title
   * matching) - callers render them in their own "unattributed" group. */
  unattributedAttempts: ExecutionAttempt[];
}

/**
 * The one pure join every page should render `LogicalWork` from. Groups raw
 * execution attempts (liveness/status truth) by canonical task and merges in
 * the open-item metadata - see this module's own top-of-file doc comment.
 */
export function deriveLogicalWork(
  input: DeriveLogicalWorkInput,
): DeriveLogicalWorkResult {
  const byKey = new Map<
    string,
    { task: TaskRef; attempts: ExecutionAttempt[] }
  >();
  const unattributedAttempts: ExecutionAttempt[] = [];

  for (const run of input.attempts) {
    const attempt = toExecutionAttempt(run);
    if (run.issueNumber === undefined) {
      unattributedAttempts.push(attempt);
      continue;
    }
    const task: TaskRef = {
      repository: run.repo,
      issueNumber: run.issueNumber,
    };
    const key = taskRefKey(task);
    const existing = byKey.get(key);
    if (existing) existing.attempts.push(attempt);
    else byKey.set(key, { task, attempts: [attempt] });
  }

  // A task can also exist purely because it has open-item metadata (idle
  // work with no attempts at all - included so a caller can still ask
  // "what state is #42 in" uniformly).
  for (const [key, meta] of input.taskMeta) {
    if (!byKey.has(key)) {
      byKey.set(key, {
        task: { repository: meta.repo, issueNumber: meta.issueNumber },
        attempts: [],
      });
    }
  }

  const work: LogicalWork[] = [];
  for (const [key, entry] of byKey) {
    const task = entry.task;
    const meta = input.taskMeta.get(key);
    const attempts = entry.attempts
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const anomalies = duplicateAttemptAnomalies(attempts);

    const baseState = stateFromAttempts(attempts);
    // Any anomaly promotes the whole task to the distinct `anomaly` state -
    // an operator who hasn't looked at a flagged duplicate yet should keep
    // seeing it flagged, not have it quietly stop being called out.
    const unavailable = input.unavailableTaskKeys?.has(key) ?? false;
    const state: LogicalWorkState = unavailable
      ? 'unavailable'
      : anomalies.length > 0
        ? 'anomaly'
        : (meta?.humanNeeded ?? false)
          ? 'human-needed'
          : baseState;

    const fallbackAttempt = attempts.at(-1);
    work.push({
      task,
      title:
        meta?.title ?? fallbackAttempt?.displayTitle ?? `#${task.issueNumber}`,
      url: meta?.url ?? taskRefUrl(task),
      // Presentation-only (which badge a card leads with), never a control
      // decision - matches `selectedAgentPipeline`'s "no implicit
      // precedence" spirit.
      selectedPipeline: fallbackAttempt?.pipeline,
      state,
      attempts,
      anomalies,
      provenance: unavailable ? { kind: 'unavailable' } : { kind: 'legacy' },
    });
  }

  work.sort(
    (a, b) => LOGICAL_STATE_PRIORITY[a.state] - LOGICAL_STATE_PRIORITY[b.state],
  );

  return { work, unattributedAttempts };
}

export interface ActivityMetrics {
  /** Distinct tasks with in-flight logical work - never a run count. */
  logicalTaskCount: number;
  /** Raw workflow attempts currently queued, across every task. */
  queuedAttempts: number;
  /** Raw workflow attempts currently running, across every task. */
  runningAttempts: number;
  /** From `listSelfHostedRunnersForRepo` - physical capacity, not work.
   * Undefined when the runner API was unavailable (matches `FleetSummary`
   * itself being optional). */
  onlineRunners?: number;
  busyRunners?: number;
}

const IN_FLIGHT_STATES = new Set<LogicalWorkState>([
  'dispatching',
  'active',
  'human-needed',
  'anomaly',
]);

/**
 * The three metrics #306 requires stay visibly distinct: how much logical
 * work exists, how many physical attempts are consuming (or waiting for) a
 * runner right now, and how many runners physically exist. None of these is
 * a substitute for another - a queued attempt consumes no runner, and one
 * logical task can have zero, one, or several attempts (see this module's
 * own top comment).
 */
export function deriveActivityMetrics(
  work: LogicalWork[],
  attempts: ExecutionAttempt[],
  fleet?: FleetSummary,
): ActivityMetrics {
  // One pass rather than two separate `.filter(...).length` calls - this
  // runs on every /agents page render over the full flattened attempt list
  // across every watched repo, so it's worth counting both statuses
  // together instead of scanning `attempts` twice.
  let queuedAttempts = 0;
  let runningAttempts = 0;
  for (const attempt of attempts) {
    if (attempt.status === 'queued') queuedAttempts++;
    else if (attempt.status === 'running') runningAttempts++;
  }
  return {
    logicalTaskCount: work.filter((w) => IN_FLIGHT_STATES.has(w.state)).length,
    queuedAttempts,
    runningAttempts,
    onlineRunners: fleet?.online,
    busyRunners: fleet?.busy,
  };
}

/** Builds the `taskMeta` input map `deriveLogicalWork` needs from the
 * open-item board, keyed consistently with the attempt side via
 * `repoItemKey`. */
export function taskMetaFromItems(
  items: {
    repo: TaskRef['repository'];
    number: number;
    title: string;
    url: string;
    humanNeeded?: boolean;
  }[],
): Map<string, TaskMeta> {
  const taskMeta = new Map<string, TaskMeta>();
  for (const item of items) {
    taskMeta.set(repoItemKey(item.repo, item.number), {
      repo: item.repo,
      issueNumber: item.number,
      title: item.title,
      url: item.url,
      humanNeeded: item.humanNeeded,
    });
  }
  return taskMeta;
}
