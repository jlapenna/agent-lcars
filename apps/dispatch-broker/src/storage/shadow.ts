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
 * means) or `'shadow'`. `parseDispatchStorageMode` is the one place that
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
 * it is the plain read-compare-write primitive, reused directly by tests
 * that want a throw to surface rather than be swallowed.
 *
 * ## Divergence
 *
 * `diffStoredTask` compares what storage held BEFORE this write (the
 * `readTask` result) against the state this pass is about to write --
 * `projectLedgerToStoredTask`'s own reading of the ledger, which is always
 * the operative comparison: shadow mode's whole purpose is asking "does
 * storage already agree with what the ledger says right now". Logged via
 * `::warning::` (visible in the run log without opening a job summary),
 * naming the task, the field, and both values -- enough to diagnose without
 * re-deriving anything.
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
} from './port.js';

// ---------------------------------------------------------------------------
// The switch.
// ---------------------------------------------------------------------------

export const DISPATCH_STORAGE_MODES = ['off', 'shadow'] as const;
export type DispatchStorageMode = (typeof DISPATCH_STORAGE_MODES)[number];

/**
 * Parse the raw `DISPATCH_STORAGE_MODE` repo variable. Unset or empty (what
 * an undeclared GitHub Actions repo variable reads as) is `'off'`, matching
 * this switch's documented default and rollback position. Anything other
 * than `'off'`/`'shadow'` throws -- a typo must fail loudly, never be
 * treated as a deliberate rollback.
 */
export function parseDispatchStorageMode(
  raw: string | undefined,
): DispatchStorageMode {
  const value = (raw ?? '').trim();
  if (value === '' || value === 'off') return 'off';
  if (value === 'shadow') return 'shadow';
  throw new Error(
    `Unrecognized DISPATCH_STORAGE_MODE '${raw}': expected 'off' (or unset) or 'shadow'.`,
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
 * see ledger.ts's own `LedgerAuthorizationObservation` comment).
 * `AuthorizationRecord` only has room for the decision shape, so an
 * observation -- evidence the broker already accepted, by definition,
 * since it is in `ledger.sources` at all -- maps to `{ authorized: true }`:
 * the broker recording it IS the admission decision for observational
 * evidence. Absent entirely (an older ledger predating this field) maps
 * the same way, for the same reason.
 */
function mapAuthorization(
  authorization: LedgerAuthorization | undefined,
): AuthorizationRecord {
  if (!authorization) return { authorized: true };
  if ('authorized' in authorization) {
    return {
      authorized: authorization.authorized,
      actor: authorization.actor,
      rule: authorization.rule,
    };
  }
  return { authorized: true, actor: authorization.actor };
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
  };
}

// ---------------------------------------------------------------------------
// Divergence.
// ---------------------------------------------------------------------------

export interface FieldDivergence {
  field: 'desiredIntentId' | 'signals' | 'intents';
  ledgerValue: unknown;
  storedValue: unknown;
}

/**
 * Compares what storage held BEFORE this pass's write (`before`, possibly
 * `undefined` if this task has never been observed) against what the
 * ledger says right now (`desired`, from `projectLedgerToStoredTask`).
 * `before === undefined` is never a divergence -- there is no baseline yet
 * to disagree with, just a first observation.
 */
export function diffStoredTask(
  before: StoredTask | undefined,
  desired: StoredTaskInput,
): FieldDivergence[] {
  if (!before) return [];
  const fields: FieldDivergence['field'][] = [
    'desiredIntentId',
    'signals',
    'intents',
  ];
  const divergences: FieldDivergence[] = [];
  for (const field of fields) {
    const ledgerValue = desired[field];
    const storedValue = before[field];
    if (!isDeepStrictEqual(ledgerValue, storedValue)) {
      divergences.push({ field, ledgerValue, storedValue });
    }
  }
  return divergences;
}

function logDivergences(task: TaskRef, divergences: FieldDivergence[]): void {
  for (const divergence of divergences) {
    console.log(
      `::warning::dispatch-storage shadow divergence for ` +
        `${task.repository}#${task.issue}, field '${divergence.field}': ` +
        `ledger=${JSON.stringify(divergence.ledgerValue)} ` +
        `storage=${JSON.stringify(divergence.storedValue)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The observer.
// ---------------------------------------------------------------------------

/**
 * Read storage's current state for `ledger.task`, log any divergence
 * against what the ledger says right now, and write the ledger's projected
 * state forward. Deliberately unwrapped -- a throw (a real outage, an
 * expired token, a CAS conflict) propagates -- so `maybeObserveDispatchStorage`
 * below is the one place that decides what "best-effort" means, and this
 * function stays a plain, directly testable primitive.
 */
export async function observeDispatchStorage(
  port: StoragePort,
  ledger: DispatchLedger,
  now: string = new Date().toISOString(),
): Promise<void> {
  const task: TaskRef = ledger.task;
  const before = await port.readTask(task);
  const desired = projectLedgerToStoredTask(ledger);
  logDivergences(task, diffStoredTask(before, desired));
  await port.writeTask(task, before?.revision, desired, now);
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
