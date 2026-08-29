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
 * run is live is refused, preserving the mutex invariant.
 */

const isoUtc = z.iso.datetime({ offset: false });

/**
 * A task is identified by where the work lives. Two anchors exist:
 *
 * - a GitHub issue or pull request, `{ repo, issue }` -- the shape every
 *   persisted document already carries, kept byte-for-byte;
 * - a native work item, `{ workId }`, a ULID minted by the caller.
 *
 * The variants are discriminated by which key is present, never by a new
 * required field: `FirestoreStore` zod-parses every persisted Task, Run,
 * and OutboxEntry on read, so a variant requiring a field legacy documents
 * lack would reject the whole existing dataset.
 */
/** GitHub limits an owner/name repository full name to 140 characters
 * (39-character owner, slash, 100-character repository). */
export const GITHUB_REPO_MAX_LENGTH = 140;

/** Zod's integer check is safe-integer bounded; name that ceiling so the
 * task-key and run-id bounds below stay coupled to accepted input. */
export const GITHUB_ISSUE_MAX = Number.MAX_SAFE_INTEGER;

export const githubAnchorSchema = z.strictObject({
  repo: z
    .string()
    .max(GITHUB_REPO_MAX_LENGTH)
    .regex(/^[\w.-]+\/[\w.-]+$/u),
  issue: z.number().int().positive().max(GITHUB_ISSUE_MAX),
});
export type GithubAnchor = z.infer<typeof githubAnchorSchema>;

/** Crockford base32, 26 characters: a ULID. Excludes I, L, O, U. */
export const WORK_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export const workAnchorSchema = z.strictObject({
  workId: z.string().regex(WORK_ID_RE),
});
export type WorkAnchor = z.infer<typeof workAnchorSchema>;

export const taskIdSchema = z.union([githubAnchorSchema, workAnchorSchema]);
export type TaskId = z.infer<typeof taskIdSchema>;

export function isGithubAnchor(id: TaskId): id is GithubAnchor {
  return 'repo' in id;
}

export function isWorkAnchor(id: TaskId): id is WorkAnchor {
  return 'workId' in id;
}

/**
 * `repo#issue` for GitHub anchors (unchanged) and `work:<ulid>` for native
 * ones. `:` is outside the repo-name charset, so the two can never collide
 * as Firestore document ids.
 */
export function taskKey(id: TaskId): string {
  return isWorkAnchor(id) ? `work:${id.workId}` : `${id.repo}#${id.issue}`;
}

/** `mintRun` appends `/r${task.runCount + 1}`. A persisted task accepts a
 * safe-integer `runCount`; its one final legal increment still has 16 digits.
 * The longest GitHub key is therefore 140 + `#` + 16 + `/r` + 16 = 175.
 * Native Work run IDs are only 49 characters, so GitHub sets this bound. */
export const RUN_ID_MAX_LENGTH =
  GITHUB_REPO_MAX_LENGTH +
  1 + // #
  String(GITHUB_ISSUE_MAX).length +
  2 + // /r
  String(GITHUB_ISSUE_MAX + 1).length;

/** Orchestrator-generated dependent IDs must admit the longest run ID too. */
const RETRY_REQUEST_ID_MAX_LENGTH = 'retry:'.length + RUN_ID_MAX_LENGTH;
const OUTBOX_ENTRY_ID_MAX_LENGTH = 'dispatch/'.length + RUN_ID_MAX_LENGTH;

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

export const runExecutorSchema = z.enum(['github-actions', 'queue']);
export type RunExecutor = z.infer<typeof runExecutorSchema>;

/** A `queue`-executor run's claim state, written directly onto the run
 *  document by the outbox drain and by `POST /runs/claim` — see the design
 *  spec's "Queue state machine". Absent means "not a queue-executor run,
 *  or not yet drained". `tokenHash` is `sha256(token)` hex, never the raw
 *  token; `apps/console/src/lib/run-token.ts` mints/hashes it. */
export const runQueueSchema = z.strictObject({
  state: z.enum(['queued', 'claimed']),
  claimedAt: isoUtc.optional(),
  claimedBy: z.string().min(1).max(256).optional(),
  tokenHash: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
});
export type RunQueue = z.infer<typeof runQueueSchema>;

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
  runId: z.string().min(1).max(RUN_ID_MAX_LENGTH),
  task: taskIdSchema,
  state: runStateSchema,
  /** The agent/pipeline asked to do the work; opaque routing data. */
  pipeline: z.string().min(1).max(128),
  /** Idempotency: the request that created this run. A retry of the same
   *  request maps to this run instead of creating a second one. */
  requestId: z.string().min(1).max(RETRY_REQUEST_ID_MAX_LENGTH),
  /** Opaque dispatch parameters (e.g. mode, reply text) recorded at request
   *  time and handed verbatim to the executor. Never interpreted here. */
  params: z.record(z.string().max(64), z.string().max(8_192)).optional(),
  /** Which executor drains this run's dispatch. Absent means
   *  `'github-actions'` -- every run persisted before this field existed
   *  parses unchanged (see model.ts's top comment on the anchor union for
   *  why this stays optional-with-a-default rather than required). */
  executor: runExecutorSchema.optional(),
  /** `executor: 'queue'` runs only -- see `runQueueSchema`. */
  queue: runQueueSchema.optional(),
  /** A live run must renew before this instant or it is presumed lost. */
  leaseExpiresAt: isoUtc,
  result: runResultSchema.optional(),
  events: z.array(runEventSchema).max(64),
  createdAt: isoUtc,
  updatedAt: isoUtc,
});
export type Run = z.infer<typeof runSchema>;

/**
 * A native work item's payload -- who asked and what for. The orchestrator
 * stores it and never interprets it, exactly as it treats `Run.params`;
 * `libs/work` owns the shape. Bounded so a runaway caller cannot bloat the
 * task document towards Firestore's 1 MiB limit.
 */
export const WORK_PAYLOAD_MAX_BYTES = 32_768;

export const workPayloadSchema = z
  .record(z.string().max(64), z.unknown())
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <=
      WORK_PAYLOAD_MAX_BYTES,
    {
      message: `work payload exceeds ${WORK_PAYLOAD_MAX_BYTES} bytes`,
    },
  );
export type WorkPayload = z.infer<typeof workPayloadSchema>;

export const taskSchema = z.strictObject({
  task: taskIdSchema,
  /** The mutex. Set iff a run is live. */
  activeRunId: z.string().min(1).max(RUN_ID_MAX_LENGTH).optional(),
  /** Monotonic count of runs ever started, for run-id minting. */
  runCount: z.number().int().nonnegative(),
  /** How many runs in a row have gone `lost`, since the last one that
   *  `finished` or was `canceled`. Optional: absent means 0 (existing
   *  Firestore task documents predate this field and are read that way by
   *  `FirestoreStore`'s zod validation). Drives the bounded auto-retry
   *  budget in `decide.ts`'s `expireLease`/`MAX_AUTO_RETRIES`. */
  consecutiveLost: z.number().int().nonnegative().optional(),
  /** The work item's payload, written once when the task is created by
   *  its first request and never modified by the orchestrator afterward.
   *  A native anchor always carries one; a GitHub anchor carries one once
   *  console-side derivation has populated it (sub-project 5's `work` for
   *  every anchor) and is absent otherwise -- a legacy task, or one
   *  requested through a path that does not derive it
   *  (`handleDispatchRequest`; see the design spec). */
  work: workPayloadSchema.optional(),
  /** Native anchors only: set by `closeTask` when an operator closes an
   *  item that has no live run. A closed task refuses further requests. */
  closedAt: isoUtc.optional(),
  updatedAt: isoUtc,
});
export type Task = z.infer<typeof taskSchema>;

/**
 * Effects that must survive the transaction that decided them. A worker
 * drains this; the decision and its side effect are never in one step.
 */
const outboxEntryBaseSchema = z.strictObject({
  entryId: z.string().min(1).max(OUTBOX_ENTRY_ID_MAX_LENGTH),
  kind: z.enum(['dispatch-run', 'report-outcome']),
  task: taskIdSchema,
  runId: z.string().min(1).max(RUN_ID_MAX_LENGTH),
  /** Incremented by every `claimPendingOutbox` claim, including expired-
   *  lease recovery -- so this counts how many times the entry has been
   *  handed to a worker, not how many times delivery was actually
   *  attempted (a claim can be lost to a crash before a single GitHub call
   *  happens). Retirement/backoff below deliberately do NOT key off this
   *  field for that reason; it remains purely descriptive bookkeeping
   *  (surfaced in `orchestrator-dispatch.ts`'s failure logging). */
  attempts: z.number().int().nonnegative(),
  /** #1548 follow-up: when this entry first failed an *actual* delivery
   *  attempt -- set once, by `orchestrator-dispatch.ts`'s
   *  `settleRetryableFailure`, and never touched by a mere claim or by
   *  expired-lease recovery (see `attempts` above). Retirement
   *  (`OUTBOX_RETIRE_AFTER_MS`) is gated on elapsed time since this
   *  instant, not on `attempts`, so a burst of claim traffic during a
   *  transient GitHub outage can no longer exhaust a retry budget within
   *  minutes. Additive/optional: absent means "has not failed a delivery
   *  attempt (yet)" -- both for a `pending` entry with no history, and for
   *  any entry persisted before this field existed, which is treated as
   *  "failing for the first time now" the moment a failure IS next
   *  recorded for it, never backdated. */
  firstFailedAt: isoUtc.optional(),
  /** #1548 follow-up: backoff. An entry that just failed a delivery
   *  attempt is not eligible to be reclaimed again until this instant, so
   *  the fast dispatch/completion drain cadence (on top of the 30-minute
   *  reconcile) can't hammer an entry that is currently failing -- see
   *  `OUTBOX_BACKOFF_BASE_MS`/`_CAP_MS`. Additive/optional: absent means
   *  claimable immediately, which is every entry's state before its first
   *  delivery failure. */
  nextAttemptAt: isoUtc.optional(),
  /** #1548 follow-up: how many *actual* delivery attempts have failed in a
   *  row -- exponential backoff's exponent. Unlike `attempts`, never
   *  incremented by a claim or by lease recovery on their own; only by
   *  `settleRetryableFailure` recording a real failed delivery. Additive/
   *  optional: absent means zero. */
  deliveryFailures: z.number().int().nonnegative().optional(),
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
 * migration. `failed` is additive the same way (#1548): a terminal
 * dead-letter state for an entry that has been failing actual delivery
 * attempts for longer than `OUTBOX_RETIRE_AFTER_MS` (in
 * `orchestrator-dispatch.ts`) without ever delivering, so it stops being
 * retried forever instead of either retrying indefinitely or being
 * misrecorded as `done` (which means "delivered"). Existing
 * `pending`/`leased`/`done` documents parse unchanged; no migration needed
 * for this either, nor for `firstFailedAt`/`nextAttemptAt`/
 * `deliveryFailures` above (same additive-optional treatment).
 */
export const outboxEntrySchema = z.discriminatedUnion('state', [
  outboxEntryBaseSchema.extend({ state: z.literal('pending') }),
  outboxEntryBaseSchema.extend({
    state: z.literal('leased'),
    claimId: z.uuid(),
    leaseExpiresAt: isoUtc,
  }),
  outboxEntryBaseSchema.extend({ state: z.literal('done') }),
  outboxEntryBaseSchema.extend({ state: z.literal('failed') }),
]);
export type OutboxEntry = z.infer<typeof outboxEntrySchema>;
export type LeasedOutboxEntry = Extract<OutboxEntry, { state: 'leased' }>;

/**
 * Claim order for due, pending outbox entries -- shared by `MemoryStore`
 * and `FirestoreStore` so both `claimPendingOutbox` implementations agree
 * (see their contract in `store-contract.ts`).
 *
 * Ascending by `attempts`, so an entry that has never been handed to a
 * worker always outranks one that has, however many already-attempted
 * entries are also due; ties (most commonly two entries that have never
 * been attempted) break ascending by `createdAt`, oldest first, for a
 * deterministic order rather than an incidental one.
 *
 * #1553 stopped one persistently-failing entry from blocking every *other*
 * entry within a single drain invocation (`excludeEntryIds`), but neither
 * store's claim query was ordered at all: a large recurring set of
 * due-again, already-failing entries (e.g. every PR-anchored
 * `report-outcome` entry before the permission fix in `github-app-tokens
 * .ts`) can still occupy the entire claim `limit` on every invocation,
 * forever, crowding out entries that have never been claimed even once --
 * exactly the production shape measured: 60 pending entries untouched
 * across 20 reconcile passes, 40 of them over 72 hours old with
 * `attempts: 0`. Sorting by `attempts` first fixes that: every entry gets
 * its first attempt before any entry gets a second, so a due entry can
 * never be starved indefinitely by a smaller or larger set of entries that
 * keep failing and coming back due.
 *
 * Deliberately a client-side sort of an already-fetched, equality-filtered
 * page rather than a Firestore `orderBy` -- `attempts` combined with the
 * existing `state == 'pending'` equality filter would need a new composite
 * index, and the pending population this sorts is already read in full
 * client-side for the same reason (see `FirestoreStore.claimPendingOutbox`'s
 * own comment on `pendingSnapshot`).
 */
export function byOutboxClaimFairness(a: OutboxEntry, b: OutboxEntry): number {
  return (
    a.attempts - b.attempts || Date.parse(a.createdAt) - Date.parse(b.createdAt)
  );
}
