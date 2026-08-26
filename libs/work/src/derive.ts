import {
  isLive,
  MAX_AUTO_RETRIES,
  type Run,
  type Task,
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
  if (latest.state === 'finished') return latest.result?.ok ? 'done' : 'parked';
  // lost: the sweep retries until the budget is spent, then leaves it.
  return (task.consecutiveLost ?? 0) > MAX_AUTO_RETRIES ? 'parked' : 'running';
}

export interface ItemRunView {
  runId: string;
  state: Run['state'];
  pipeline: string;
  createdAt: string;
  updatedAt: string;
  result?: Run['result'];
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
    })),
    sessions: [...(input.sessions ?? [])],
  };
}

/**
 * `toItemView`, but for a caller that must survive a task whose `work` is
 * absent or only partially populated. The orchestrator persists `Task.work`
 * as an optional loose record -- a native task can legitimately reach the
 * store with no `work`, or one that predates a field this schema now
 * requires -- so a listing that projects every native task must not let one
 * bad payload 500 the whole page. Returns `undefined` instead of throwing;
 * the caller decides what to do with a skipped item (typically: log and
 * omit it).
 */
export function toItemViewSafe(input: {
  workId: string;
  task: Task;
  runs: readonly Run[];
  sessions?: readonly ItemSessionView[];
}): ItemView | undefined {
  const result = workPayloadSchema.safeParse(input.task.work);
  return result.success ? toItemView(input) : undefined;
}
