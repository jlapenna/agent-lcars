/**
 * Dispatch-storage shadow mode (#645 Phase 6): the switch, its inertness
 * guarantee, and the best-effort observer that projects the comment
 * ledger's resulting state onto `StoragePort` for comparison -- without
 * ever making storage authoritative. Scope is deliberately narrow: the
 * ledger stays the sole authority through everything in this file; this
 * only adds the ability to observe, so a soak can produce evidence before a
 * later change moves authority onto storage.
 *
 * ## The switch
 *
 * `DISPATCH_STORAGE_MODE` (a repo variable, read via `env()` by main.ts's
 * `broker()`) is `'off'` (default -- also what an unset/empty variable
 * means), `'shadow'`, or `'authority'`. Authority behavior lives in
 * `authority.ts`; this module's observer remains shadow-only.
 * `parseDispatchStorageMode` is the one place that
 * turns the raw string into a `DispatchStorageMode`, and it throws loudly
 * for anything else -- a typo in the repo variable (e.g. "authoritative",
 * "on") must fail the run, not silently behave like `'off'`. main.ts calls
 * it once, early in `broker()`, before any ledger work, so a
 * misconfiguration is reported immediately rather than discovered after a
 * dispatch pass already did real work.
 *
 * ## Inertness of 'off'
 *
 * `maybeObserveDispatchStorage` is the only entry point `broker()` calls,
 * and it takes the port as a lazily-invoked factory (`createPort`), never a
 * constructed value. When `mode !== 'shadow'` it returns before ever
 * calling `createPort` -- so `'off'` provably never constructs a
 * `FirestoreRestStoragePort` (no token read, no project ID read), never
 * calls any of its methods (no HTTP request), and therefore mints nothing
 * and requests nothing. main.ts's own `createShadowStoragePort` (the one
 * place a caller ever supplies as `createPort`) is unreachable code, not
 * merely behaviorally inert, whenever mode is `'off'`.
 *
 * ## Shadow-mode failure containment
 *
 * `maybeObserveDispatchStorage` wraps port construction AND the whole
 * observe-and-write sequence in one try/catch and never rethrows: a
 * Firestore outage, an expired or missing token, or a genuine CAS conflict
 * (another writer/observer raced this same task) all become one
 * `::warning::` log line, never a thrown error reaching `broker()`'s own
 * outer `failClosed` path. The comment ledger is still authoritative --
 * this function's whole job is to observe it, not to gate it -- so nothing
 * about the dispatch this pass is doing may depend on whether this
 * succeeds. `observeDispatchStorage` itself is intentionally NOT wrapped:
 * it is the plain read-write-read-back primitive, reused directly by tests
 * that want a throw (e.g. a CAS conflict) to surface rather than be
 * swallowed.
 *
 * ## Storage integrity signals
 *
 * An earlier version of this file compared what storage held BEFORE this
 * pass's write (`readTask`, run before writing) against what THIS pass's
 * ledger says right now (`projectLedgerToStoredTask`'s output). That
 * comparison is pure noise: on every pass after the first, `before` is
 * necessarily the projection this same observer wrote during the PREVIOUS
 * pass, while the thing it was being diffed against is the ledger AFTER the
 * current transition -- so a completion callback moving `active` ->
 * `completed`, a newly-accepted source, or a new generation all make the
 * two sides disagree by design, every single pass, with nothing wrong
 * having happened. Firing a warning on ordinary change trains an operator
 * to ignore it -- the same failure mode that left `bootstrap-canary` red on
 * every run in this repo with nobody noticing.
 *
 * What actually indicates a problem is the integrity of the storage path
 * itself, not whether the ledger changed between two passes (it is
 * *supposed* to). This file emits two signals, and only these two:
 *
 *   - `checkRoundTrip`: after `writeTask` returns, a FRESH `readTask` of the
 *     very task just written must hand back exactly what was written. A
 *     mismatch (a field differs, or the task is missing entirely) means
 *     storage did not durably hold what this pass just gave it -- lost
 *     bytes, a broken (de)serializer (see firestore-rest-port.ts's
 *     hand-rolled field marshalling), or a second writer landing in the gap
 *     between this pass's own commit and its own next read. This observer
 *     is meant to be the only writer to storage (see "Shadow-mode failure
 *     containment" above), so any of these is a real storage-path defect
 *     worth investigating -- it says nothing about whether the ledger's
 *     *decision* was correct, only whether storage faithfully held it.
 *     Logged via `::warning::`, naming the task, the field, and both the
 *     expected and actual value.
 *
 *   - A compare-and-swap conflict: `writeTask` throwing
 *     `TaskWriteConflictError` when some other write landed between this
 *     pass's `readTask` and its own `writeTask`. For a single-writer
 *     control plane, that means a second writer exists -- itself the
 *     finding, not a transient hiccup to shrug off. This is not raised from
 *     `checkRoundTrip`: the error propagates unwrapped out of
 *     `observeDispatchStorage` (deliberately not caught here -- see
 *     "Shadow-mode failure containment" above) up to
 *     `maybeObserveDispatchStorage`'s containment catch, whose warning
 *     already includes the error's own message -- and
 *     `TaskWriteConflictError`'s message already names both the expected
 *     and the actual revision, so nothing is lost by not special-casing it
 *     here.
 *
 * Neither signal fires on an ordinary pass-to-pass ledger transition --
 * see ./shadow.spec.ts's "a normal pass-to-pass transition... produces no
 * divergence warning" test, the regression test for the noise this section
 * replaces.
 *
 * ## The ledger -> StoredTask projection
 *
 * `projectLedgerToStoredTask` is a read-only projection: it never mutates
 * the `DispatchLedger` it is given (proven by ./shadow.spec.ts's byte-
 * identical-ledger assertion). The ledger's own, richer 11-state
 * `LedgerGenerationState` vocabulary is folded onto the port's 6-state
 * `IntentState` by `mapGenerationState` below -- see that function's own
 * comment for the mapping and why each collapse was chosen. This is a
 * best-effort observational projection, not a wire format either side is
 * contractually bound to -- shadow mode's job is to surface disagreement
 * for a human to look at, not to be the last word on what "equivalent"
 * means.
 *
 * Authorization is projected faithfully, not fabricated: `mapAuthorization`
 * below maps a real ledger decision to a decision record and a bare
 * observation (completion callbacks, close/reopen, reconciliation, label
 * self-heal -- see ledger.ts's `LedgerAuthorizationObservation`) to an
 * observation record, never synthesizing `authorized: true` for evidence
 * that was merely observed. This matters specifically because this
 * projection is headed toward becoming the authority (#645 Phase 6): a
 * later storage-authoritative cutover must inherit an audit trail that
 * still distinguishes "policy admitted this" from "this was merely seen to
 * happen", not one that was flattened into looking authorized here.
 */

import { isDeepStrictEqual } from 'node:util';

import {
  type DispatchLedger,
  formatAttemptId,
  LEDGER_ACTIVE_GENERATION_STATES,
  type LedgerAuthorization,
  type LedgerGeneration,
  type LedgerGenerationState,
  type LedgerSource,
} from '@agent-lcars/dispatch-contracts';

import {
  type AttemptRecord,
  type AuthorizationRecord,
  type IntentRecord,
  type IntentState,
  type SignalRecord,
  type StoragePort,
  type StoredTask,
  type StoredTaskInput,
  type TaskRef,
} from './port';

// ---------------------------------------------------------------------------
// The switch.
// ---------------------------------------------------------------------------

export const DISPATCH_STORAGE_MODES = ['off', 'shadow', 'authority'] as const;
export type DispatchStorageMode = (typeof DISPATCH_STORAGE_MODES)[number];

/**
 * Parse the raw `DISPATCH_STORAGE_MODE` repo variable. Unset or empty (what
 * an undeclared GitHub Actions repo variable reads as) is `'off'`, matching
 * this switch's documented default and rollback position. Anything other
 * than `'off'`/`'shadow'` throws -- a typo must fail loudly, never be
 * treated as a deliberate rollback. `authority` selects Firestore as the
 * controller state authority and the comment as a compatibility projection.
 */
export function parseDispatchStorageMode(
  raw: string | undefined,
): DispatchStorageMode {
  const value = (raw ?? '').trim();
  if (value === '' || value === 'off') return 'off';
  if (value === 'shadow') return 'shadow';
  if (value === 'authority') return 'authority';
  throw new Error(
    `Unrecognized DISPATCH_STORAGE_MODE '${raw}': expected 'off' (or unset), 'shadow', or 'authority'.`,
  );
}

// ---------------------------------------------------------------------------
// Ledger -> StoredTask projection.
// ---------------------------------------------------------------------------

/**
 * Folds the ledger's 11-state `LedgerGenerationState` onto the port's
 * 6-state `IntentState`. Exhaustive over every ledger state -- the `never`
 * assignment in the `default` branch fails to compile if a new ledger state
 * is ever added without updating this mapping:
 *   - accepted/pending/dispatching -> themselves; the port has the same
 *     names for these three.
 *   - dispatch-unknown -> dispatching: the controller still does not know
 *     whether the dispatch landed -- the same "still trying to resolve
 *     dispatch" phase as 'dispatching' from a storage observer's point of
 *     view (see markDispatchUnknown, broker.ts).
 *   - active/completion-observed/completion-awaiting-terminal -> active:
 *     all three mean "a worker run is bound and not yet authoritatively
 *     terminal" -- completion-observed/-awaiting-terminal are en route to
 *     completed, not a distinct phase this port's coarser vocabulary needs.
 *   - completed -> completed.
 *   - dispatch-rejected/superseded/superseded-by-close -> superseded: none
 *     of the three ever produced a live, completed attempt -- 'superseded'
 *     is the port's one vocabulary word for "this intent's pursuit ended
 *     without completing", which covers a definite launch rejection the
 *     same as a generation preempted by a newer one or the anchor closing.
 */
function mapGenerationState(state: LedgerGenerationState): IntentState {
  switch (state) {
    case 'accepted':
      return 'accepted';
    case 'pending':
      return 'pending';
    case 'dispatching':
    case 'dispatch-unknown':
      return 'dispatching';
    case 'active':
    case 'completion-observed':
    case 'completion-awaiting-terminal':
      return 'active';
    case 'completed':
      return 'completed';
    case 'dispatch-rejected':
    case 'superseded':
    case 'superseded-by-close':
      return 'superseded';
    default: {
      const exhaustive: never = state;
      throw new Error(
        `Unhandled ledger generation state: ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * `LedgerAuthorization` is a union of a real decision (`authorized:
 * boolean`) or a bare observation (`observed: true`, no decision at all --
 * see ledger.ts's own `LedgerAuthorizationObservation` comment, and
 * port.ts's `AuthorizationObservationRecord`, which mirrors it for exactly
 * this reason). This mapping preserves that distinction rather than
 * collapsing it: a decision maps to a decision, an observation maps to an
 * observation. Mapping an observation to `{ authorized: true }` -- what an
 * earlier version of this function did, reasoning that the broker having
 * accepted the evidence at all is itself an admission decision -- was
 * wrong: `ledger.sources` entries for a completion callback, close/reopen,
 * reconciliation, or label self-heal were never evaluated against
 * authorization policy at all, so writing `authorized: true` for them
 * fabricates a positive policy decision that this projection becomes the
 * durable record of. That matters most because this projection is headed
 * toward being the authority (#645 Phase 6) -- a later storage-authoritative
 * cutover must not inherit an audit trail that claims evidence was
 * authorized when it was merely observed.
 *
 * Absent entirely (an older ledger predating this field, or any future
 * source kind that legitimately carries no authorization at all) maps to
 * `{ observed: true }` with no `actor` -- still never a fabricated
 * decision, just the honest "no decision is known" case with the least
 * information available.
 */
function mapAuthorization(
  authorization: LedgerAuthorization | undefined,
): AuthorizationRecord {
  if (!authorization) return { observed: true };
  if ('authorized' in authorization) {
    return {
      authorized: authorization.authorized,
      actor: authorization.actor,
      rule: authorization.rule,
    };
  }
  return {
    observed: true,
    actor: authorization.actor,
    workflow: authorization.workflow,
  };
}

function mapSignal(source: LedgerSource): SignalRecord {
  return {
    sourceKind: source.sourceKind,
    sourceId: source.sourceId,
    occurredAt: source.occurredAt,
    authorization: mapAuthorization(source.authorization),
  };
}

/**
 * `generation.attempt`'s fields past `token` are set incrementally by
 * distinct broker transitions (ledger.ts's own `LedgerRunAttempt`
 * comment), so an attempt recorded before `attemptId` existed as a field
 * may lack it -- re-derive it the same deterministic way `formatAttemptId`
 * always has (generation + intentId), rather than leaving it undefined.
 * `token` defaults to `''` for the same "older ledger" case:
 * `AttemptRecord.token` is required, but nothing in this shadow-only
 * comparison depends on it being non-empty.
 */
function mapAttempt(generation: LedgerGeneration): AttemptRecord | undefined {
  const attempt = generation.attempt;
  if (!attempt) return undefined;
  return {
    attemptId:
      attempt.attemptId ??
      formatAttemptId({
        generation: generation.generation,
        intentId: generation.intentId,
      }),
    token: attempt.token ?? '',
    dispatchStartedAt: attempt.dispatchStartedAt ?? generation.occurredAt,
    runId: attempt.runId,
    runUrl: attempt.runUrl,
    htmlUrl: attempt.htmlUrl,
    boundAt: attempt.boundAt,
    completedAt: attempt.completedAt,
    conclusion: attempt.conclusion,
    outcome: attempt.outcome,
    outcomeReference: attempt.outcomeReference,
  };
}

function mapIntent(generation: LedgerGeneration): IntentRecord {
  return {
    intentId: generation.intentId,
    sourceId: generation.sourceId,
    occurredAt: generation.occurredAt,
    state: mapGenerationState(generation.state),
    attempt: mapAttempt(generation),
  };
}

/**
 * The read-only ledger -> `StoredTaskInput` projection this file's header
 * describes. `desiredIntentId` -- port.ts's own "the active or pending
 * generation" analog -- prefers an active generation's intent, falls back
 * to a pending one, and then to an accepted-but-not-yet-dispatched one: all
 * three are "what the controller is currently working toward" from a
 * storage observer's point of view, in the same priority order
 * `dispatchAccepted` (main.ts) itself works through them.
 */
export function projectLedgerToStoredTask(
  ledger: DispatchLedger,
): StoredTaskInput {
  const activeGeneration = ledger.generations.find((generation) =>
    LEDGER_ACTIVE_GENERATION_STATES.has(generation.state),
  );
  const pendingGeneration = ledger.generations.find(
    (generation) => generation.state === 'pending',
  );
  const acceptedGeneration = ledger.generations.find(
    (generation) => generation.state === 'accepted',
  );
  const desiredIntentId =
    activeGeneration?.intentId ??
    pendingGeneration?.intentId ??
    acceptedGeneration?.intentId;
  return {
    desiredIntentId,
    signals: ledger.sources.map(mapSignal),
    intents: ledger.generations.map(mapIntent),
    controllerState: structuredClone(ledger),
  };
}

// ---------------------------------------------------------------------------
// Storage integrity signals. See this file's header "Storage integrity
// signals" for why this compares a write against its own read-back rather
// than comparing storage's pre-write state against the current ledger.
// ---------------------------------------------------------------------------

export interface FieldDivergence {
  field:
    'desiredIntentId' | 'signals' | 'intents' | 'controllerState' | 'revision';
  expected: unknown;
  actual: unknown;
}

/**
 * Firestore stores the port's optional properties with "absent, not null"
 * semantics. Both concrete adapters deliberately drop `undefined` object
 * properties (and defensively drop undefined array elements), while the
 * object returned from `writeTask` can still contain those values because
 * it is the caller's structured clone from immediately before persistence.
 *
 * Normalize both sides to the value Firestore can actually represent before
 * judging a round trip. Object key order needs no special treatment:
 * `isDeepStrictEqual` already compares plain objects by their keys rather
 * than insertion order. This helper exists for the hidden absent-vs-
 * undefined distinction that JSON-formatted warning output cannot show.
 */
function storageComparable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((element) => element !== undefined)
      .map(storageComparable);
  }
  if (value && typeof value === 'object') {
    const comparable: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      if (fieldValue === undefined) continue;
      comparable[key] = storageComparable(fieldValue);
    }
    return comparable;
  }
  return value;
}

/**
 * Round-trip integrity for this pass's own write: `written` is what
 * `writeTask` reported it stored (the values this process asked storage to
 * hold, stamped with the revision storage assigned). `after` is a FRESH
 * `readTask`, performed immediately afterward -- never `written` itself,
 * since that would only prove this process's local object round-trips
 * through itself, not that storage's real persistence/(de)serialization
 * path does.
 *
 * `after === undefined` (storage now has nothing for a task this pass just
 * wrote) is reported as a `revision` divergence with `actual: undefined` --
 * the clearest case of "a write that did not land as issued". Otherwise
 * each of `desiredIntentId`/`signals`/`intents` that differs is reported
 * individually, and a `revision` divergence is reported if the freshly-read
 * revision does not equal what this pass's own write just produced -- which,
 * since this observer is meant to be the only writer (see the header's
 * "Shadow-mode failure containment"), can only mean a second writer touched
 * this task in the instant between this pass's commit and its own next read.
 *
 * This says nothing about whether the LEDGER's decision was correct -- only
 * whether storage faithfully held what shadow mode just gave it.
 */
export function checkRoundTrip(
  written: StoredTask,
  after: StoredTask | undefined,
): FieldDivergence[] {
  if (!after) {
    return [
      { field: 'revision', expected: written.revision, actual: undefined },
    ];
  }
  const fields: Array<
    'desiredIntentId' | 'signals' | 'intents' | 'controllerState'
  > = ['desiredIntentId', 'signals', 'intents', 'controllerState'];
  const divergences: FieldDivergence[] = [];
  for (const field of fields) {
    const expected = written[field];
    const actual = after[field];
    if (
      !isDeepStrictEqual(storageComparable(expected), storageComparable(actual))
    ) {
      divergences.push({ field, expected, actual });
    }
  }
  if (after.revision !== written.revision) {
    divergences.push({
      field: 'revision',
      expected: written.revision,
      actual: after.revision,
    });
  }
  return divergences;
}

function logRoundTripMismatches(
  task: TaskRef,
  divergences: FieldDivergence[],
): void {
  for (const divergence of divergences) {
    console.log(
      `::warning::dispatch-storage shadow round-trip mismatch for ` +
        `${task.repository}#${task.issue}, field '${divergence.field}': ` +
        `expected=${JSON.stringify(divergence.expected)} ` +
        `actual=${JSON.stringify(divergence.actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The observer.
// ---------------------------------------------------------------------------

/**
 * Write the ledger's projected state forward, read it back, and log any
 * round-trip mismatch (see `checkRoundTrip`). A compare-and-swap conflict
 * from `writeTask` (another writer raced this same task) is a separate,
 * also-meaningful signal but is not caught here -- see this file's header
 * "Storage integrity signals" for why letting it propagate loses nothing.
 * Deliberately unwrapped -- a throw (a real outage, an expired token, a CAS
 * conflict) propagates -- so `maybeObserveDispatchStorage` below is the one
 * place that decides what "best-effort" means, and this function stays a
 * plain, directly testable primitive.
 */
export async function observeDispatchStorage(
  port: StoragePort,
  ledger: DispatchLedger,
  now: string = new Date().toISOString(),
): Promise<void> {
  const task: TaskRef = ledger.task;
  const before = await port.readTask(task);
  const desired = projectLedgerToStoredTask(ledger);
  const written = await port.writeTask(task, before?.revision, desired, now);
  const after = await port.readTask(task);
  logRoundTripMismatches(task, checkRoundTrip(written, after));
}

/**
 * The one entry point `broker()` calls. Gates entirely on `mode`: `'off'`
 * returns before `createPort` is ever invoked -- see this file's header
 * "Inertness of 'off'" -- and `'shadow'` wraps port construction AND
 * `observeDispatchStorage` in one try/catch so nothing this does can turn
 * an otherwise-successful dispatch pass into a failed job. See this file's
 * header "Shadow-mode failure containment".
 */
export async function maybeObserveDispatchStorage(
  mode: DispatchStorageMode,
  createPort: () => StoragePort,
  ledger: DispatchLedger,
  now?: string,
): Promise<void> {
  if (mode !== 'shadow') return;
  try {
    await observeDispatchStorage(createPort(), ledger, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `::warning::dispatch-storage shadow observation failed for ` +
        `${ledger.task.repository}#${ledger.task.issue}: ${message}`,
    );
  }
}
