import {
  type AgentPipeline,
  type AgentRun,
  duplicateLivePipelineGroups,
  type FleetSummary,
} from './agent-activity';
import {
  repoItemKey,
  type TaskRef,
  taskRefKey,
  taskRefUrl,
} from './watched-repo';

/** A task's execution state is always projected from its authoritative Run
 * records. GitHub supplies issue/PR metadata only. */
export type LogicalWorkState =
  | 'unavailable'
  | 'dispatching'
  | 'active'
  | 'human-needed'
  | 'completed'
  | 'anomaly'
  | 'unknown';

export interface LogicalWorkAnomaly {
  kind: 'duplicate-active-runs';
  detail: string;
}

export type LogicalWorkProvenance =
  | { kind: 'authoritative'; revision?: number }
  | { kind: 'no-history' }
  | { kind: 'unavailable' };

export type LogicalTaskRef =
  TaskRef | { repository: TaskRef['repository']; workId: string };

export interface LogicalWork {
  task: LogicalTaskRef;
  title: string;
  url: string;
  selectedPipeline?: AgentPipeline;
  state: LogicalWorkState;
  /** Every authoritative Run for this task, oldest first. */
  runs: AgentRun[];
  anomalies: LogicalWorkAnomaly[];
  provenance: LogicalWorkProvenance;
}

export interface TaskMeta {
  repo: TaskRef['repository'];
  issueNumber: number;
  title: string;
  url: string;
  humanNeeded?: boolean;
}

function logicalTaskKey(task: LogicalTaskRef): string {
  return 'workId' in task ? `work:${task.workId}` : taskRefKey(task);
}

function logicalTaskUrl(task: LogicalTaskRef): string {
  return 'workId' in task ? `/work/${task.workId}` : taskRefUrl(task);
}

function stateFromRuns(runs: readonly AgentRun[]): LogicalWorkState {
  if (runs.some((run) => run.status === 'running')) return 'active';
  if (runs.some((run) => run.status === 'queued')) return 'dispatching';
  return runs.length > 0 ? 'completed' : 'unknown';
}

function duplicateRunAnomalies(runs: AgentRun[]): LogicalWorkAnomaly[] {
  return Array.from(duplicateLivePipelineGroups(runs)).map(
    ([pipeline, group]) => ({
      kind: 'duplicate-active-runs',
      detail: `${group.length} ${pipeline} runs are queued or running for the same task at once (${group.map((run) => run.id).join(', ')}).`,
    }),
  );
}

export interface DeriveLogicalWorkInput {
  /** Raw authoritative Runs, ungrouped. */
  runs: AgentRun[];
  /** Task-state reads that failed. They must render as unavailable, never be
   * replaced with a GitHub-derived lifecycle guess. */
  unavailableTaskKeys?: ReadonlySet<string>;
  /** GitHub issue/PR presentation metadata keyed by `repoItemKey`. */
  taskMeta: Map<string, TaskMeta>;
}

export interface DeriveLogicalWorkResult {
  work: LogicalWork[];
  /** Malformed records without either authoritative anchor are kept out of
   * task grouping rather than guessed onto an issue by title. */
  unattributedRuns: AgentRun[];
}

/** Groups authoritative Run records by their durable Task/Work anchor and
 * joins GitHub metadata solely for presentation. */
export function deriveLogicalWork(
  input: DeriveLogicalWorkInput,
): DeriveLogicalWorkResult {
  const byKey = new Map<string, { task: LogicalTaskRef; runs: AgentRun[] }>();
  const unattributedRuns: AgentRun[] = [];

  for (const run of input.runs) {
    if (run.issueNumber === undefined && run.workId === undefined) {
      unattributedRuns.push(run);
      continue;
    }
    const task: LogicalTaskRef =
      run.workId === undefined
        ? { repository: run.repo, issueNumber: run.issueNumber as number }
        : { repository: run.repo, workId: run.workId };
    const key = logicalTaskKey(task);
    const existing = byKey.get(key);
    if (existing) existing.runs.push(run);
    else byKey.set(key, { task, runs: [run] });
  }

  for (const [key, meta] of input.taskMeta) {
    if (!byKey.has(key)) {
      byKey.set(key, {
        task: { repository: meta.repo, issueNumber: meta.issueNumber },
        runs: [],
      });
    }
  }

  const work: LogicalWork[] = [];
  for (const [key, entry] of byKey) {
    const meta = input.taskMeta.get(key);
    const unavailable = input.unavailableTaskKeys?.has(key) ?? false;
    const anomalies = duplicateRunAnomalies(entry.runs);
    const state = unavailable
      ? 'unavailable'
      : anomalies.length > 0
        ? 'anomaly'
        : meta?.humanNeeded
          ? 'human-needed'
          : stateFromRuns(entry.runs);
    const firstRun = entry.runs[0];
    work.push({
      task: entry.task,
      title: meta?.title ?? firstRun?.displayTitle ?? 'Untitled work',
      url: meta?.url ?? logicalTaskUrl(entry.task),
      ...(meta === undefined && firstRun !== undefined
        ? { selectedPipeline: firstRun.pipeline }
        : {}),
      state,
      runs: entry.runs,
      anomalies,
      provenance: unavailable
        ? { kind: 'unavailable' }
        : entry.runs.length > 0
          ? { kind: 'authoritative' }
          : { kind: 'no-history' },
    });
  }
  work.sort((a, b) => a.title.localeCompare(b.title));
  return { work, unattributedRuns };
}

export interface ActivityMetrics {
  logicalTaskCount: number;
  queuedRuns: number;
  runningRuns: number;
  onlineRunners?: number;
  busyRunners?: number;
}

const IN_FLIGHT_STATES = new Set<LogicalWorkState>([
  'dispatching',
  'active',
  'human-needed',
  'anomaly',
]);

/** Keeps logical task count, queue occupancy, and physical capacity as
 * distinct authoritative measures. */
export function deriveActivityMetrics(
  work: LogicalWork[],
  runs: AgentRun[],
  fleet?: FleetSummary,
): ActivityMetrics {
  let queuedRuns = 0;
  let runningRuns = 0;
  for (const run of runs) {
    if (run.status === 'queued') queuedRuns++;
    else if (run.status === 'running') runningRuns++;
  }
  return {
    logicalTaskCount: work.filter((item) => IN_FLIGHT_STATES.has(item.state))
      .length,
    queuedRuns,
    runningRuns,
    onlineRunners: fleet?.online,
    busyRunners: fleet?.busy,
  };
}

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
