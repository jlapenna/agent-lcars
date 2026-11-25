import type { z } from 'zod';

import { isEffectfulRun, MAX_AUTO_RETRIES, maxAutoRetries } from './decide';
import {
  deliveryWaiting,
  isLive,
  isWorkAnchor,
  type itemStateSchema,
  type OutboxEntry,
  type Run,
  type Task,
  type TaskDerived,
} from './model';

export type ItemState = z.infer<typeof itemStateSchema>;

type RunOrder = Pick<Run, 'runId' | 'createdAt'>;

export function compareRunOrder(a: RunOrder, b: RunOrder): number {
  return (
    a.createdAt.localeCompare(b.createdAt) ||
    a.runId.localeCompare(b.runId, undefined, { numeric: true })
  );
}

/** Newest run first: createdAt descending, numeric run generation as a tiebreak.
 * Full Runs and public run views use the same ordering. */
export function latestRun<T extends RunOrder>(
  runs: readonly T[],
): T | undefined {
  return [...runs].sort((a, b) => compareRunOrder(b, a))[0];
}

/**
 * A task's item state, read off the task and its latest run. First match
 * wins, in the order the design spec's table lists them. The orchestrator
 * store also stores it with the task (`taskDerivedFrom`, #3566) so readers
 * can query by it; the store contract checks the stored copy never drifts.
 */
export function deriveItemState(
  task: Pick<
    Task,
    'closedAt' | 'consecutiveLost' | 'delivery' | 'desiredRevision'
  >,
  runs: readonly Run[],
): ItemState {
  const latest = latestRun(runs);
  if (task.closedAt !== undefined || latest?.state === 'canceled')
    return 'canceled';
  if (deliveryWaiting(task) && latest?.state !== 'lost') {
    if (latest?.state === 'finished' && latest.result?.ok === false)
      return 'failed';
    if (latest?.state === 'finished' && latest.result?.summary === 'park')
      return 'parked';
    return 'running';
  }
  if (latest === undefined) return 'running';
  if (isLive(latest.state)) return 'running';
  if (latest.triagePublication?.state === 'complete') return 'done';
  if (latest.sourceRevision !== undefined && task.desiredRevision === undefined)
    return 'canceled';
  if (latest.triagePublication?.state === 'pending') return 'running';
  if (latest.triagePublication?.state === 'failed') return 'failed';
  if (latest.triagePublication?.state === 'superseded') return 'canceled';
  if (
    task.delivery?.state === 'complete' &&
    task.delivery.runId === latest.runId
  )
    return 'done';
  if (latest.state === 'finished') {
    // Only an explicit park is a human handoff. Missing deliverables and
    // execution failures need diagnosis, not a fabricated human decision.
    if (latest.result?.summary === 'park') return 'parked';
    return latest.result?.ok ? 'done' : 'failed';
  }
  // lost: the sweep retries until the budget is spent, then leaves it.
  const retryBudget = maxAutoRetries(latest);
  if (isEffectfulRun(latest) && retryBudget === 0) return 'failed';
  return task.consecutiveLost > retryBudget ||
    (latest.sourceRevision !== undefined &&
      (latest.revisionAttempt ?? 1) > MAX_AUTO_RETRIES)
    ? 'failed'
    : 'running';
}

/** The item state stored with a task document (#3566): written in the same
 * transaction as the task and runs it derives from. */
export function taskDerivedFrom(
  task: Pick<
    Task,
    | 'closedAt'
    | 'consecutiveLost'
    | 'delivery'
    | 'desiredRevision'
    | 'updatedAt'
  >,
  runs: readonly Run[],
): TaskDerived {
  const latest = latestRun(runs);
  const state = deriveItemState(task, runs);
  const event = runs.some((run) => run.sourceRevision !== undefined);
  return {
    state,
    ...(latest === undefined ? {} : { latestRunId: latest.runId }),
    event,
    // Sort keys present only on the tasks a reader wants: a query ordered by
    // one skips every task without it, so the newest stopped or event tasks
    // need only Firestore's automatic single-field index.
    ...(state === 'parked' || state === 'failed'
      ? { stoppedAt: task.updatedAt }
      : {}),
    ...(event ? { eventAt: task.updatedAt } : {}),
  };
}

/** Prefix of the outbox entries {@link itemStateEventOutbox} writes. */
export const AGENT_EVENT_OUTBOX_PREFIX = 'agent-event/';

/** The id of the agent event for a native Work item's transition: the Work
 * id and the task revision that made it. A revision is written once, so the
 * id is stable across every retry and redelivery of that transition. */
export function workAgentEventId(workId: string, revision: number): string {
  return `work.${workId}.r${revision}`;
}

/** The event id an `agent-event` outbox entry carries in its entry id. */
export function agentEventIdOf(entry: Pick<OutboxEntry, 'entryId'>): string {
  if (!entry.entryId.startsWith(AGENT_EVENT_OUTBOX_PREFIX))
    throw new Error(`not an agent-event outbox entry: ${entry.entryId}`);
  return entry.entryId.slice(AGENT_EVENT_OUTBOX_PREFIX.length);
}

/**
 * The `agent-event` outbox entry for a task write that changes a native Work
 * item's state (#3568), written by the store in the same transaction as the
 * task, so the change and the notice that it happened commit together and a
 * failed delivery is retried by the outbox drain rather than lost. Writes
 * that leave the state unchanged (claims, heartbeats, an automatic retry of a
 * lost run) write nothing.
 *
 * Nothing is written for a GitHub-anchored task (GitHub's own sources cover
 * those), for the write that creates a task (nobody can have subscribed to
 * an id that did not exist), when the state before the write is unknown
 * because a stored run failed to parse, or for an item with no runs, which
 * has no run for the entry to name.
 */
export function itemStateEventOutbox(input: {
  /** The task and its runs before the write; the task is undefined when
   * this write creates it, the runs when they could not all be read. */
  previous: { task: Task | undefined; runs: readonly Run[] | undefined };
  /** The task and its runs as the write leaves them. */
  next: { task: Task; runs: readonly Run[] };
  /** The task document revision this write stores. */
  revision: number;
}): OutboxEntry[] {
  const { previous, next, revision } = input;
  const anchor = next.task.task;
  if (
    !isWorkAnchor(anchor) ||
    previous.task === undefined ||
    previous.runs === undefined
  )
    return [];
  const before = deriveItemState(previous.task, previous.runs);
  const after = deriveItemState(next.task, next.runs);
  const latest = latestRun(next.runs);
  if (before === after || latest === undefined) return [];
  const at =
    latest.updatedAt > next.task.updatedAt
      ? latest.updatedAt
      : next.task.updatedAt;
  return [
    {
      entryId: `${AGENT_EVENT_OUTBOX_PREFIX}${workAgentEventId(anchor.workId, revision)}`,
      kind: 'agent-event',
      task: anchor,
      runId: latest.runId,
      itemState: after,
      state: 'pending',
      attempts: 0,
      createdAt: at,
      updatedAt: at,
    },
  ];
}
