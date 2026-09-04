import {
  isLive,
  MAX_AUTO_RETRIES,
  type Run,
  type Task,
  type TaskId,
  taskKey,
} from '@agent-lcars/orchestrator';

import { type WorkOrigin, workPayloadSchema, type WorkSpec } from './spec';

export type ItemState = 'running' | 'done' | 'parked' | 'canceled';

/** Newest run first: createdAt descending, runId as a stable tiebreak. */
export function latestRun(runs: readonly Run[]): Run | undefined {
  return [...runs].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId),
  )[0];
}

/**
 * Item state is never stored; it is read off the task and its latest run.
 * First match wins, in the order the design spec's table lists them.
 */
export function deriveItemState(
  task: Pick<Task, 'closedAt' | 'consecutiveLost'>,
  runs: readonly Run[],
): ItemState {
  const latest = latestRun(runs);
  if (task.closedAt !== undefined || latest?.state === 'canceled')
    return 'canceled';
  if (latest === undefined) return 'running';
  if (isLive(latest.state)) return 'running';
  if (latest.state === 'finished') {
    // #1608 put `park` in OK_OUTCOMES (apps/console/src/lib/run-result.ts),
    // so a run that parked with real evidence now settles `ok: true` too --
    // `summary` is what still distinguishes it from an ordinary success.
    // `ok: false` still reads `parked`: a failed run needs a human as well.
    return latest.result?.ok && latest.result.summary !== 'park'
      ? 'done'
      : 'parked';
  }
  // lost: the sweep retries until the budget is spent, then leaves it.
  return task.consecutiveLost > MAX_AUTO_RETRIES ? 'parked' : 'running';
}

export interface ItemRunView {
  runId: string;
  state: Run['state'];
  pipeline: string;
  createdAt: string;
  updatedAt: string;
  result?: Run['result'];
  queue?: { state: 'queued' | 'claimed'; claimedBy?: string };
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
  spec: WorkSpec;
  origin: WorkOrigin;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
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
  spec: WorkSpec;
  origin: WorkOrigin;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  runs: ItemRunView[];
}

export function toItemView(input: {
  workId: string;
  task: Task;
  runs: readonly Run[];
  sessions?: readonly ItemSessionView[];
}): ItemView {
  const payload = workPayloadSchema.parse(input.task.work);
  const runs = [...input.runs].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  return {
    id: input.workId,
    state: deriveItemState(input.task, input.runs),
    spec: payload.spec,
    origin: payload.origin,
    createdAt: runs[0]?.createdAt ?? input.task.updatedAt,
    updatedAt: input.task.updatedAt,
    ...(input.task.closedAt === undefined
      ? {}
      : { closedAt: input.task.closedAt }),
    runs: runs.map((r) => ({
      runId: r.runId,
      state: r.state,
      pipeline: r.pipeline,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ...(r.result === undefined ? {} : { result: r.result }),
      ...(r.queue === undefined
        ? {}
        : {
            queue: {
              state: r.queue.state,
              ...(r.queue.claimedBy === undefined
                ? {}
                : { claimedBy: r.queue.claimedBy }),
            },
          }),
    })),
    sessions: [...(input.sessions ?? [])],
  };
}

/** Projects any native or GitHub anchor with a valid `Task.work` payload. */
export function toWorkSummary(input: {
  task: Task;
  runs: readonly Run[];
}): WorkSummary {
  const payload = workPayloadSchema.parse(input.task.work);
  const runs = [...input.runs].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  return {
    id: taskKey(input.task.task),
    anchor: input.task.task,
    state: deriveItemState(input.task, input.runs),
    spec: payload.spec,
    origin: payload.origin,
    createdAt: runs[0]?.createdAt ?? input.task.updatedAt,
    updatedAt: input.task.updatedAt,
    ...(input.task.closedAt === undefined
      ? {}
      : { closedAt: input.task.closedAt }),
    runs: runs.map((r) => ({
      runId: r.runId,
      state: r.state,
      pipeline: r.pipeline,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ...(r.result === undefined ? {} : { result: r.result }),
      ...(r.queue === undefined
        ? {}
        : {
            queue: {
              state: r.queue.state,
              ...(r.queue.claimedBy === undefined
                ? {}
                : { claimedBy: r.queue.claimedBy }),
            },
          }),
    })),
  };
}
