/**
 * A transactional storage port for the dispatch controller, and the durable
 * launch outbox that closes the gap `markDispatchUnknown` (modules/
 * scheduler.ts) today only papers over (#645 Phase 5, first two bullets:
 * "Implement a transactional storage port and durable launch outbox" /
 * "Start with an in-memory/reference implementation and contract tests").
 *
 * ## Why this exists now
 *
 * Phase 5 was written as conditional: "conditional on Phases 1-4 surfacing a
 * genuine ledger-authority race that a comment-based ledger cannot resolve,
 * not as an assumed default next step." No such race appeared -- Phase 2's
 * concurrency work (#689) closed the one outstanding one.
 *
 * What appeared instead, while fixing a credential boundary in Phase 3, is a
 * stronger problem than a race: `loadLedger` (github-api.ts) authenticates
 * the dispatch ledger by comment AUTHOR, and `saveLedger` updates it with a
 * `PATCH`. Editing a GitHub comment does not change its author. So any
 * credential carrying `issues: write` -- which an agent whose job includes
 * commenting on issues necessarily holds -- can rewrite the ledger while the
 * author check keeps passing, because nothing about authorship changed.
 * Scoping the credential cannot fix this: the capability that lets an agent
 * do its work is the same capability that lets it forge the record of what
 * it did. See the issue-#645 comment "The comment ledger is forgeable by the
 * agents it controls" for the full finding.
 *
 * In `DISPATCH_STORAGE_MODE=authority`, this port provides state the
 * controlled code cannot write. Firestore stores the exact controller
 * aggregate alongside its query-friendly signal/intent projections and a
 * CAS lease shared by hosted admission and the Action fallback. The
 * in-memory implementation and contract suite remain the executable
 * reference for every backend operation.
 *
 * ## What "transactional" means here
 *
 * Not a general multi-key ACID transaction across arbitrary records. The
 * transactional unit is ONE task's aggregate state -- the same boundary the
 * current ledger already uses: one pinned issue comment per task, with
 * `sources`/`generations` nested inside a single `revision`-stamped
 * document (see ../../../../libs/dispatch-contracts/src/ledger.ts). `writeTask`
 * below is a compare-and-swap: the caller passes the revision it last read,
 * and the write only applies if the stored revision still matches. A
 * mismatch is reported as a typed `TaskWriteConflictError`, never resolved
 * by silently overwriting -- that is what #645 asks Phase 5 to make
 * expressible ("a revision/precondition parameter... rather than assuming
 * last-write-wins").
 *
 * `updateTask` (bottom of this file) is a convenience read-modify-write
 * wrapper built ON TOP of `readTask`/`writeTask`, not part of the port
 * surface itself. Keeping it out of the interface means a concrete backend
 * only has to implement the CAS primitive -- which Firestore, DynamoDB, and
 * a plain SQL row with a `WHERE revision = ?` clause can all do natively --
 * rather than retry-on-conflict semantics of its own.
 *
 * ## Which of the issue's nine record kinds this models
 *
 * "Durable controller state" names nine logical records: signals,
 * authorization decisions, tasks and desired revisions, intents, attempts,
 * attempt events, launch outbox operations, run bindings, lane readiness.
 * This port does not have to cover all nine richly; it has to be honest
 * about which it models and which it does not yet.
 *
 * Modeled, nested inside the per-task aggregate (`StoredTask`) because that
 * is the same aggregate the current ledger already treats as one document --
 * none of these need independent transactional identity from the task they
 * belong to, any more than they do in `DispatchLedger` today:
 *   - signals                  -> `StoredTask.signals[]`
 *   - authorization decisions  -> `SignalRecord.authorization`
 *   - tasks and desired revisions -> `StoredTask` itself (`revision`,
 *     `desiredIntentId`)
 *   - intents                  -> `StoredTask.intents[]`
 *   - attempts                 -> `IntentRecord.attempt`
 *   - run bindings              -> `AttemptRecord.runId`/`runUrl`/`htmlUrl`/
 *     `boundAt`
 *
 * Modeled with its own top-level surface, deliberately NOT nested inside a
 * task record (see "Why the outbox is not part of the task aggregate"
 * below):
 *   - launch outbox operations -> `LaunchOutboxOperation`,
 *     `recordLaunchIntent` / `resolveLaunchOutcome` /
 *     `listPendingLaunchOperations`
 *
 * Deliberately NOT modeled yet -- named here so the gap is a recorded
 * decision, not an oversight found later:
 *   - attempt events: the ordered per-attempt phase/event log #645's shared-
 *     contracts section calls `AttemptEvent`. It needs a genuinely different
 *     access pattern from everything else in this port -- monotonic append,
 *     read back by attempt, never rewritten -- where every other record here
 *     lives inside a whole-aggregate CAS write. Folding it into
 *     `IntentRecord.attempt` would make every event append contend on the
 *     same per-task revision as unrelated fields (other intents, signals)
 *     that have nothing to do with it. Left for the port revision that
 *     actually needs it.
 *   - lane readiness: #645's target-architecture diagram draws this as an
 *     INPUT to the dispatch controller ("lane readiness" arrow into system
 *     1), not a fact the controller owns -- the issue's own source-of-truth
 *     table gives "runner lifecycle and capacity" to Runner platform
 *     (system 2). A dispatch-controller storage port has no business being
 *     where lane readiness is written; it would only ever read it from
 *     wherever Runner platform's own port lives.
 *
 * ## Why the outbox is not part of the task aggregate
 *
 * The failure this exists to prevent is the one already seen in production:
 * a dispatch POST whose response is lost, leaving the controller unsure
 * whether a run started (`markDispatchUnknown` handles the aftermath today,
 * inside the ledger). The recipe an outbox implements is:
 *
 *   1. record intent to launch, durably, BEFORE the dispatch call;
 *   2. make the call;
 *   3. resolve the recorded intent to what happened, after.
 *
 * A crash between (1) and (3) must leave a recoverable trace -- an entry
 * that is durably known to exist and is still `pending`, so a recovery pass
 * can reconcile it against reality (e.g. query GitHub Actions for a run
 * carrying this attempt's marker). That recovery pass necessarily needs to
 * ask "what did we record intent to launch but never learn the outcome of,
 * across every task" -- a query across the whole outbox, not one task's
 * document. Nesting outbox entries inside `StoredTask` would make that scan
 * mean "read every task", which defeats the point of a durable outbox being
 * cheap to poll. This port does not implement the recovery/reconciliation
 * policy itself -- only the primitive a recovery process needs:
 * `listPendingLaunchOperations`.
 */

import type { DispatchLedger } from '@agent-lcars/dispatch-contracts';

// ---------------------------------------------------------------------------
// Task aggregate: signals, authorization decisions, intents, attempts, and
// run bindings, all scoped to one task and written under one CAS revision.
// ---------------------------------------------------------------------------

/**
 * The canonical task a stored record belongs to. Deliberately the same shape
 * as `LedgerTaskRef` (../../../../libs/dispatch-contracts/src/ledger.ts) --
 * this port is a second storage backend for the same domain concept, not a
 * different one, and `repositoryId` is what survives a repository rename
 * here for the same reason it does there.
 */
export interface TaskRef {
  repositoryId: number;
  /** `owner/name`. */
  repository: string;
  issue: number;
}

/** A stable, storage-agnostic key for one task. Exported so a future
 *  backend can use it as a natural document/row ID without every
 *  implementation re-deriving its own scheme. */
export function taskKey(task: TaskRef): string {
  return `${task.repositoryId}:${task.issue}`;
}

/**
 * A real authorization decision: some actor did something and policy either
 * admitted it or did not. Mirrors `LedgerAuthorizationDecision`'s shape
 * deliberately -- see `TaskRef` above for why this port reuses the domain's
 * existing vocabulary rather than inventing a parallel one.
 */
export interface AuthorizationDecisionRecord {
  authorized: boolean;
  actor?: string;
  rule?: string;
}

/**
 * Evidence that something *happened*, carrying no decision at all. Mirrors
 * `LedgerAuthorizationObservation` (../../../../libs/dispatch-contracts/src/
 * ledger.ts) -- see that interface's own comment for why this must stay a
 * distinct variant rather than being collapsed into
 * `AuthorizationDecisionRecord`: a completion callback, close/reopen,
 * reconciliation, or label self-heal source was never evaluated against
 * authorization policy, so a record derived from one must not claim
 * `authorized: true` (or any `authorized` value at all) -- that would
 * fabricate a positive policy decision that was never made. Discriminate on
 * `observed` before reading `authorized`.
 */
export interface AuthorizationObservationRecord {
  observed: true;
  actor?: string;
  workflow?: string;
}

/**
 * A real authorization decision, or the absence of one -- mirrors
 * `LedgerAuthorization`'s own two-variant union (ledger.ts) for the same
 * "reuse the domain's existing vocabulary" reason `TaskRef` gives. This
 * union is what makes it possible for a projection like dispatch-broker's
 * `shadow.ts` to represent observational evidence faithfully instead of
 * mapping it onto a fabricated decision.
 */
export type AuthorizationRecord =
  AuthorizationDecisionRecord | AuthorizationObservationRecord;

/** One accepted external signal: the evidence a task's desired state changed
 *  and the decision that admitted it. */
export interface SignalRecord {
  sourceKind: string;
  sourceId: string;
  occurredAt: string;
  authorization: AuthorizationRecord;
}

/** One workflow attempt bound to an intent. Fields past `token` are set only
 *  as the corresponding real-world event happens, same discipline as
 *  `LedgerRunAttempt` -- presence is itself a record of how far the attempt
 *  got. */
export interface AttemptRecord {
  attemptId: string;
  token: string;
  dispatchStartedAt: string;
  runId?: number;
  runUrl?: string;
  htmlUrl?: string;
  boundAt?: string;
  completedAt?: string;
  conclusion?: string;
}

export const INTENT_STATES = [
  'accepted',
  'pending',
  'dispatching',
  'active',
  'completed',
  'superseded',
] as const;

export type IntentState = (typeof INTENT_STATES)[number];

/** One intent accepted for a task, and its attempt if it has reached
 *  dispatch. */
export interface IntentRecord {
  intentId: string;
  sourceId: string;
  occurredAt: string;
  state: IntentState;
  attempt?: AttemptRecord;
}

/**
 * A short, renewable serialization lease held by one controller delivery.
 * Firestore's compare-and-swap revision makes acquisition atomic; the
 * expiry makes a crashed hosted request recoverable without an operator
 * deleting state by hand.
 */
export interface TaskLease {
  owner: string;
  acquiredAt: string;
  expiresAt: string;
}

/**
 * The transactional unit: everything the dispatch controller knows about one
 * task, at one revision. `revision`/`updatedAt` are owned by the port
 * (`writeTask` sets them) -- a caller never sets them directly, the same way
 * `mutate()` in modules/ledger-core.ts owns `ledger.revision`/`updatedAt`
 * today.
 */
export interface StoredTask {
  task: TaskRef;
  revision: number;
  updatedAt: string;
  /** The intent ID the task is currently working toward, if any -- the
   *  storage-port analog of "the active or pending generation" in the
   *  comment ledger. */
  desiredIntentId?: string;
  signals: SignalRecord[];
  intents: IntentRecord[];
  /** The exact controller aggregate. During migration the narrower fields
   * above remain query-friendly projections, while this value is the state
   * authority used by both hosted admission and the Action fallback. */
  controllerState?: DispatchLedger;
  /** Present only while one controller delivery owns this task. */
  lease?: TaskLease;
}

/** The part of `StoredTask` a caller supplies to `writeTask` -- everything
 *  except the fields the port itself stamps. */
export type StoredTaskInput = Omit<
  StoredTask,
  'task' | 'revision' | 'updatedAt'
>;

/**
 * Thrown by `writeTask` when the caller's `expectedRevision` does not match
 * what is actually stored -- the port's one conflict signal, in place of a
 * silent last-write-wins overwrite.
 *
 * `actualRevision` is `undefined` when no task is stored at all, which is
 * itself a meaningful conflict: the caller believed a task existed (or
 * believed it didn't, depending on which side of the mismatch this is).
 */
export class TaskWriteConflictError extends Error {
  constructor(
    public readonly task: TaskRef,
    public readonly expectedRevision: number | undefined,
    public readonly actualRevision: number | undefined,
  ) {
    super(
      `Task write conflict for ${task.repository}#${task.issue}: ` +
        `expected revision ${expectedRevision ?? '(none)'}, ` +
        `found ${actualRevision ?? '(none)'}`,
    );
    this.name = 'TaskWriteConflictError';
  }
}

// ---------------------------------------------------------------------------
// Launch outbox: record intent to launch before the call, resolve after.
// ---------------------------------------------------------------------------

export const LAUNCH_OUTBOX_STATUSES = [
  'pending',
  'launched',
  'rejected',
  'unknown',
] as const;

export type LaunchOutboxStatus = (typeof LAUNCH_OUTBOX_STATUSES)[number];

/** What `bindRun` (modules/scheduler.ts) needs to record a successful
 *  launch -- the same three fields `RunBinding` carries there. */
export interface LaunchOutboxRunBinding {
  runId: number;
  runUrl: string;
  htmlUrl: string;
}

/**
 * How a recorded launch intent resolved. Three outcomes, matching the three
 * the scheduler already distinguishes (modules/scheduler.ts):
 *   - `launched`: the dispatch call succeeded and bound to a real run --
 *     what `bindRun` records.
 *   - `rejected`: the dispatch call definitively failed and no run started
 *     -- what `markDispatchRejected` records.
 *   - `unknown`: the call's outcome is ambiguous (e.g. a timeout after the
 *     POST may have already landed server-side) -- what `markDispatchUnknown`
 *     records today, inside the ledger, as the aftermath of a lost response.
 */
export type LaunchOutboxResolution =
  | { status: 'launched'; binding: LaunchOutboxRunBinding }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown'; reason: string };

/**
 * One outbox entry: the durable record that launching attempt `attemptId`
 * for `task` was intended, from the moment it was recorded (`pending`)
 * through however it resolved.
 */
export interface LaunchOutboxOperation {
  /** The idempotency key -- see #645's shared-contracts section: "every
   *  externally visible effect is keyed by a stable... ID... delivery is at
   *  least once; correctness comes from idempotence." Callers should use the
   *  attemptId itself: it already exists before the dispatch call
   *  (`beginDispatch` mints it), is unique per attempt, and gives a retried
   *  `recordLaunchIntent` call the exact same key. */
  operationId: string;
  task: TaskRef;
  attemptId: string;
  recordedAt: string;
  status: LaunchOutboxStatus;
  resolvedAt?: string;
  resolution?: LaunchOutboxResolution;
}

/**
 * The storage port. A concrete implementation (in-memory today; a durable
 * backend later, per Phase 6's "obtain explicit approval before introducing
 * infrastructure-backed storage") satisfies this shape and is proven correct
 * by running ./port.contract.ts's suite against it.
 */
export interface StoragePort {
  /** Read a task's current aggregate, or `undefined` if none has ever been
   *  written. Read-your-writes: a `readTask` immediately following a
   *  successful `writeTask` for the same task observes that write. */
  readTask(task: TaskRef): Promise<StoredTask | undefined>;

  /**
   * Compare-and-swap write. `expectedRevision` must equal the currently
   * stored revision (`undefined` meaning "no task stored yet") or this
   * throws `TaskWriteConflictError` and stores nothing. On success the
   * result is stored at `revision: (expectedRevision ?? 0) + 1`.
   *
   * `now` defaults to the current time; callers with their own clock (e.g.
   * deterministic tests) may pass one.
   */
  writeTask(
    task: TaskRef,
    expectedRevision: number | undefined,
    next: StoredTaskInput,
    now?: string,
  ): Promise<StoredTask>;

  /**
   * Record intent to launch, before the dispatch call is made. Idempotent on
   * `operationId`: calling again with the same `task`/`attemptId` returns
   * the existing record unchanged rather than erroring, so an at-least-once
   * retry of the record step is safe. Calling again with the SAME
   * `operationId` but a DIFFERENT `task`/`attemptId` is a real bug (the key
   * was reused for a different attempt) and throws.
   */
  recordLaunchIntent(
    operation: { operationId: string; task: TaskRef; attemptId: string },
    now?: string,
  ): Promise<LaunchOutboxOperation>;

  /**
   * Resolve a previously recorded launch intent. Throws if `operationId` was
   * never recorded -- resolving requires having recorded first, which is the
   * ordering this port exists to enforce. Idempotent when the operation is
   * already resolved to the SAME resolution (deep-equal); throws if it is
   * already resolved to a DIFFERENT one, since a terminal outcome must never
   * be silently replaced by another.
   */
  resolveLaunchOutcome(
    operationId: string,
    resolution: LaunchOutboxResolution,
    now?: string,
  ): Promise<LaunchOutboxOperation>;

  /** Read one outbox entry by its operation ID. */
  readLaunchOperation(
    operationId: string,
  ): Promise<LaunchOutboxOperation | undefined>;

  /**
   * Every outbox entry still `pending` -- recorded, never resolved. This is
   * the primitive a recovery process polls after a crash or a lost dispatch
   * response: for each entry, ask the real world (e.g. GitHub Actions,
   * keyed by the attempt marker) what actually happened, then call
   * `resolveLaunchOutcome`. This port implements the durable "what is still
   * unresolved" query; it deliberately does NOT implement the
   * reconciliation policy itself -- that decision (how long to wait, what
   * evidence counts, retry budget) belongs with the caller, per #645's
   * "the owning system controls retry."
   */
  listPendingLaunchOperations(): Promise<LaunchOutboxOperation[]>;
}

// ---------------------------------------------------------------------------
// updateTask: retry-on-conflict read-modify-write, generic over any port.
// ---------------------------------------------------------------------------

/**
 * Read the current state of `task`, apply `transform`, and write the result
 * back with a CAS precondition -- retrying the whole read-transform-write
 * cycle if a concurrent writer wins the race, up to `maxAttempts`.
 *
 * This is deliberately NOT part of `StoragePort`: every backend must supply
 * `readTask`/`writeTask` (a single compare-and-swap primitive that
 * Firestore, DynamoDB, and a plain SQL `WHERE revision = ?` all support
 * natively), and this function builds retry-on-conflict semantics on top of
 * that once, generically, rather than asking every implementation to
 * reinvent it.
 *
 * `transform` receives `undefined` when no task is stored yet -- the same
 * "nothing here yet" case `readTask` reports -- and must return the full
 * desired next state (not a diff).
 */
export async function updateTask(
  port: StoragePort,
  task: TaskRef,
  transform: (current: StoredTask | undefined) => StoredTaskInput,
  options: { maxAttempts?: number; now?: () => string } = {},
): Promise<StoredTask> {
  const maxAttempts = options.maxAttempts ?? 5;
  const now = options.now ?? (() => new Date().toISOString());
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await port.readTask(task);
    const next = transform(current);
    try {
      return await port.writeTask(task, current?.revision, next, now());
    } catch (error) {
      if (!(error instanceof TaskWriteConflictError)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
