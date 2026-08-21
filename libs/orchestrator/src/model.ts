import { z } from 'zod';

/**
 * The orchestrator is a durable per-task mutex with an audit trail.
 *
 * A task is a GitHub issue someone wants worked. A run is one execution of
 * it. The one invariant the orchestrator owns is that a task never has two
 * live runs at once. It takes no view of what a run produced — results are
 * opaque, and judging them belongs to the task, not the orchestrator.
 *
 * A task may be worked any number of times, sequentially. By default, a
 * request while a run is live is refused. A caller may opt in to queueing
 * instead (`requestRun`'s `queueIfBusy`): the request is recorded on the
 * task as `pendingRequest` and consumed -- minted into a fresh run,
 * atomically -- by whichever settle path next releases the lock. At most
 * one request is ever queued per task; a later queued request replaces an
 * earlier one outright (last-write-wins), it does not accumulate a queue of
 * queues. Nothing in this repo sets the flag yet -- see `decide.ts`'s
 * `requestRun` for the decision and `orchestrator.ts` for how a settle path
 * consumes it.
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
  /** Who caused it: `request`, `dispatch`, `report`, `operator`, `expiry`,
   *  `infra`. `infra` is the executor itself failing rather than the agent
   *  reporting anything -- the run's execution environment reached a
   *  terminal state without a single step's worth of work reporting back
   *  (see `settleTerminal`). Kept distinct from `report` on purpose: an
   *  agent that ran and said "I failed" is a different fact from a run that
   *  never got to say anything, and only the latter is worth auto-retrying
   *  unchanged. */
  by: z.enum(['request', 'dispatch', 'report', 'operator', 'expiry', 'infra']),
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

/** A request queued against a busy task (`requestRun`'s `queueIfBusy`),
 *  waiting for the live run to settle. Mirrors the subset of a request's
 *  fields needed to mint its follow-up run later; bounded the same way
 *  `Run`'s own `pipeline`/`requestId`/`params` are. */
export const pendingRequestSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  pipeline: z.string().min(1).max(128),
  params: z.record(z.string().max(64), z.string().max(8_192)).optional(),
});
export type PendingRequest = z.infer<typeof pendingRequestSchema>;

export const taskSchema = z.strictObject({
  task: taskIdSchema,
  /** The mutex. Set iff a run is live. */
  activeRunId: z.string().min(1).max(64).optional(),
  /** Monotonic count of runs ever started, for run-id minting. */
  runCount: z.number().int().nonnegative(),
  /** How many runs in a row have gone `lost`, since the last one that
   *  `finished` or was `canceled`. Optional: absent means 0 (existing
   *  Firestore task documents predate this field and are read that way by
   *  `FirestoreStore`'s zod validation). Drives the bounded auto-retry
   *  budget in `decide.ts`'s `expireLease`/`MAX_AUTO_RETRIES`. */
  consecutiveLost: z.number().int().nonnegative().optional(),
  /** Set iff a `queueIfBusy` request arrived while a run was live and
   *  hasn't yet been consumed. Cleared -- and minted into a fresh run, in
   *  the same decision -- by whichever settle path next releases the lock
   *  (`reportResult`, `cancelRun`, `expireLease`). Optional: absent means
   *  no queued request, and existing task documents predate this field and
   *  are read that way by `FirestoreStore`'s zod validation. */
  pendingRequest: pendingRequestSchema.optional(),
  updatedAt: isoUtc,
});
export type Task = z.infer<typeof taskSchema>;

/**
 * Effects that must survive the transaction that decided them. A worker
 * drains this; the decision and its side effect are never in one step.
 */
const outboxEntryBaseSchema = z.strictObject({
  entryId: z.string().min(1).max(128),
  kind: z.enum(['dispatch-run', 'report-outcome']),
  task: taskIdSchema,
  runId: z.string().min(1).max(64),
  attempts: z.number().int().nonnegative(),
  createdAt: isoUtc,
  updatedAt: isoUtc,
});

/**
 * Delivery bookkeeping, owned by the drain worker. A `leased` entry has one
 * exclusive owner until `leaseExpiresAt`; `claimId` fences settlement so an
 * expired owner cannot overwrite a later retry's claim.
 *
 * `pending` and `done` deliberately retain their original document shape so
 * entries written before leasing was introduced remain valid without a data
 * migration.
 */
export const outboxEntrySchema = z.discriminatedUnion('state', [
  outboxEntryBaseSchema.extend({ state: z.literal('pending') }),
  outboxEntryBaseSchema.extend({
    state: z.literal('leased'),
    claimId: z.uuid(),
    leaseExpiresAt: isoUtc,
  }),
  outboxEntryBaseSchema.extend({ state: z.literal('done') }),
]);
export type OutboxEntry = z.infer<typeof outboxEntrySchema>;
export type LeasedOutboxEntry = Extract<OutboxEntry, { state: 'leased' }>;
