import { z } from 'zod';

/**
 * The orchestrator is a durable per-task mutex with an audit trail.
 *
 * A task is a GitHub issue someone wants worked. A run is one execution of
 * it. The one invariant the orchestrator owns is that a task never has two
 * live runs at once. It takes no view of what a run produced — results are
 * opaque, and judging them belongs to the task, not the orchestrator.
 *
 * A task may be worked any number of times, sequentially. A request while a
 * run is live is refused, never queued (queueing is a possible follow-up,
 * not a v1 behavior).
 */

const isoUtc = z.iso.datetime({ offset: false });

/** A task is identified by where the work lives. Nothing else. */
export const taskIdSchema = z.strictObject({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
  issue: z.number().int().positive(),
});
export type TaskId = z.infer<typeof taskIdSchema>;

export function taskKey(id: TaskId): string {
  return `${id.repo}#${id.issue}`;
}

/**
 * A run's lifecycle. `lost` is the orchestrator's own verdict, reached when
 * a live run outlives its lease without reporting; its only meaning is that
 * the task's lock is released. It says nothing about what the run did.
 */
export const runStateSchema = z.enum([
  'pending', // decided, dispatch not yet confirmed
  'running', // dispatch confirmed or first report received
  'finished', // the run reported a terminal result
  'canceled', // an operator asked for it to stop
  'lost', // lease expired with no report
]);
export type RunState = z.infer<typeof runStateSchema>;

const LIVE_STATES: readonly RunState[] = ['pending', 'running'];

export function isLive(state: RunState): boolean {
  return LIVE_STATES.includes(state);
}

/**
 * Whatever the run reported, recorded verbatim and never interpreted.
 * `summary` is bounded so a runaway report cannot bloat the record.
 */
export const runResultSchema = z.strictObject({
  ok: z.boolean(),
  summary: z.string().max(4_096).optional(),
  /** e.g. a PR URL; opaque to the orchestrator. */
  ref: z.string().max(1_024).optional(),
});
export type RunResult = z.infer<typeof runResultSchema>;

/** One recorded transition. The list of these is the run's whole history. */
export const runEventSchema = z.strictObject({
  at: isoUtc,
  to: runStateSchema,
  /** Who caused it: `request`, `dispatch`, `report`, `operator`, `expiry`. */
  by: z.enum(['request', 'dispatch', 'report', 'operator', 'expiry']),
  note: z.string().max(1_024).optional(),
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const runSchema = z.strictObject({
  runId: z.string().min(1).max(64),
  task: taskIdSchema,
  state: runStateSchema,
  /** The agent/pipeline asked to do the work; opaque routing data. */
  pipeline: z.string().min(1).max(128),
  /** Idempotency: the request that created this run. A retry of the same
   *  request maps to this run instead of creating a second one. */
  requestId: z.string().min(1).max(128),
  /** Opaque dispatch parameters (e.g. mode, reply text) recorded at request
   *  time and handed verbatim to the executor. Never interpreted here. */
  params: z.record(z.string().max(64), z.string().max(8_192)).optional(),
  /** A live run must renew before this instant or it is presumed lost. */
  leaseExpiresAt: isoUtc,
  result: runResultSchema.optional(),
  events: z.array(runEventSchema).max(64),
  createdAt: isoUtc,
  updatedAt: isoUtc,
});
export type Run = z.infer<typeof runSchema>;

export const taskSchema = z.strictObject({
  task: taskIdSchema,
  /** The mutex. Set iff a run is live. */
  activeRunId: z.string().min(1).max(64).optional(),
  /** Monotonic count of runs ever started, for run-id minting. */
  runCount: z.number().int().nonnegative(),
  updatedAt: isoUtc,
});
export type Task = z.infer<typeof taskSchema>;

/**
 * Effects that must survive the transaction that decided them. A worker
 * drains this; the decision and its side effect are never in one step.
 */
export const outboxEntrySchema = z.strictObject({
  entryId: z.string().min(1).max(128),
  kind: z.enum(['dispatch-run', 'report-outcome']),
  task: taskIdSchema,
  runId: z.string().min(1).max(64),
  /** Delivery bookkeeping, owned by the drain worker. */
  state: z.enum(['pending', 'done']),
  attempts: z.number().int().nonnegative(),
  createdAt: isoUtc,
  updatedAt: isoUtc,
});
export type OutboxEntry = z.infer<typeof outboxEntrySchema>;
