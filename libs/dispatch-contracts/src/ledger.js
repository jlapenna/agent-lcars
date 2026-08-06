/**
 * The dispatch ledger: the pinned issue comment that is the broker's durable
 * state today, and the console's read model of it.
 *
 * `broker.mjs` writes it; `apps/console/src/lib/dispatch-ledger.ts` reads it.
 * Until now the reader re-derived the marker, the schema string, the state
 * vocabulary, the comment envelope, and the record shapes by hand — its own
 * header comment said so, noting the two packages have "no relationship".
 * They had already drifted: the reader's types were missing `context`,
 * `reply`, and `digest` on a generation, and `token`, `unknownAt`,
 * `unknownReason`, `rejectedAt`, `rejectionReason`, `completionObservedAt`,
 * and `lastObservedAt` on an attempt. Nothing would have caught that.
 *
 * What is shared here is the *contract*: what a ledger comment looks like and
 * what fields a record carries. What is deliberately NOT shared is each
 * side's validation policy — the writer must fail closed and throw on
 * anything it cannot trust, while the reader must degrade a malformed or
 * older ledger to "no ledger" rather than crash a dashboard. Those are
 * genuinely different requirements, so each side keeps its own gate and
 * builds it on this one set of definitions.
 */

import { isDispatchPipeline } from './pipelines.js';

/** @typedef {import('./pipelines.js').DispatchPipeline} DispatchPipeline */

export const LEDGER_MARKER = '<!-- agent-lcars:dispatch-ledger:v1 -->';
export const LEDGER_SCHEMA = 'agent-lcars.dispatch-ledger/v1';

/**
 * Every state a generation can be in, in lifecycle order.
 *
 * Declared `const` so the state union below is derived from this one list
 * rather than hand-listed a second time as a type — the same reason the
 * console's copy used to pair a `_LIST` with a `(typeof ...)[number]`.
 */
export const LEDGER_GENERATION_STATES = /** @type {const} */ ([
  'accepted',
  'pending',
  'dispatching',
  'dispatch-unknown',
  'dispatch-rejected',
  'active',
  'completion-observed',
  'completion-awaiting-terminal',
  'completed',
  'superseded',
  'superseded-by-close',
]);

/** @typedef {(typeof LEDGER_GENERATION_STATES)[number]} LedgerGenerationState */

/**
 * The states in which a generation still has, or is about to have, a live
 * workflow attempt. The broker enforces at most one generation in this set at
 * a time, which is what makes "the active generation" well defined.
 * @type {ReadonlySet<string>}
 */
export const LEDGER_ACTIVE_GENERATION_STATES = new Set([
  'dispatching',
  'dispatch-unknown',
  'active',
  'completion-observed',
  'completion-awaiting-terminal',
]);

/**
 * The canonical task a ledger belongs to. `repositoryId` is GitHub's numeric
 * repository ID: it is what makes the binding survive a repository rename,
 * which the `repository` string alone would not.
 *
 * @typedef {object} LedgerTaskRef
 * @property {number} repositoryId
 * @property {string} repository `owner/name`.
 * @property {number} issue
 */

/**
 * One workflow attempt for a generation. Every field past `token` is written
 * by a specific broker transition, so their presence is itself the record of
 * how far the attempt got.
 *
 * @typedef {object} LedgerRunAttempt
 * @property {string} [token] Immutable dispatch token minted at
 *   `beginDispatch`, echoed back by the worker's preflight to prove the run
 *   is the one this generation dispatched.
 * @property {string} [dispatchStartedAt] Set by `beginDispatch`.
 * @property {number} [runId] Set by `bindRun` once the run is identified.
 * @property {string} [runUrl] Set by `bindRun`.
 * @property {string} [htmlUrl] Set by `bindRun`.
 * @property {string} [boundAt] Set by `bindRun`.
 * @property {string} [unknownAt] Set by `markDispatchUnknown` when the
 *   dispatch response was lost and the run may or may not exist.
 * @property {string} [unknownReason] Set by `markDispatchUnknown`.
 * @property {string} [rejectedAt] Set by `markDispatchRejected` when the
 *   dispatch definitively did not start.
 * @property {string} [rejectionReason] Set by `markDispatchRejected`.
 * @property {string} [completionObservedAt] Set by `observeCompletion` from
 *   the worker's own callback — an observation, not yet authority.
 * @property {string} [lastObservedAt] Set by `awaitTerminal` each time the
 *   run was polled and was not yet terminal.
 * @property {string} [status] Authoritative run status at `completeRun`.
 * @property {string} [conclusion] Authoritative run conclusion.
 * @property {string} [completedAt] Authoritative terminal timestamp.
 */

/**
 * @typedef {object} LedgerGeneration
 * @property {number} generation 1-based, monotonic within a ledger.
 * @property {string} intentId
 * @property {string} sourceId Joins to the `sources` entry that caused it.
 * @property {string} occurredAt
 * @property {DispatchPipeline} pipeline
 * @property {string} [mode] `implement` or `review`.
 * @property {string} [runbook]
 * @property {string} [context] Routed issue context handed to the agent.
 * @property {string} [reply] The comment body that triggered a reply-mode run.
 * @property {string} [digest] Semantic digest; a repeat of the same intent ID
 *   with a different digest is a reuse error, not a duplicate.
 * @property {LedgerGenerationState} state
 * @property {LedgerRunAttempt} [attempt]
 */

/**
 * The evidence for why a generation exists. This is the record the issue's
 * source-of-truth table calls "raw external signal and authorization
 * evidence", so it carries the authorization decision itself, not just a
 * pointer to one.
 *
 * @typedef {object} LedgerSource
 * @property {string} sourceKind A label add, a maintainer reply, the router's
 *   own `opened` event, and so on.
 * @property {string} sourceId
 * @property {string} [intentId] Joins this evidence to the generation it
 *   produced.
 * @property {number} [transportRunId]
 * @property {string} occurredAt
 * @property {string} [digest] Semantic digest of the intent this evidence
 *   carried, used to detect an intent ID reused with different content.
 * @property {LedgerAuthorization} [authorization] The decision that admitted
 *   this signal, retained as an audit record.
 */

/**
 * A real authorization decision: some actor did something, and policy either
 * admitted it or did not.
 *
 * @typedef {object} LedgerAuthorizationDecision
 * @property {boolean} authorized
 * @property {string} [actor] The login whose action produced the signal.
 * @property {string} [configuredMaintainer] The maintainer login `authorized`
 *   was evaluated against, kept so an old decision stays auditable after the
 *   configured maintainer changes.
 * @property {string} [rule] Which policy clause decided it.
 */

/**
 * Evidence that something *happened*, carrying no decision at all.
 *
 * Completion callbacks, close/reopen, reconciliation, and label self-heal
 * record what was observed rather than what was permitted — the broker
 * persists `{ observed: true, ... }` with no `authorized` key. Keeping this a
 * separate variant is the point: collapsing the two would tell a consumer
 * that `authorized` exists on records that never had it, and hide the
 * `workflow`/`actor` evidence that is the only thing these records carry.
 * Discriminate on `observed` before reading `authorized`.
 *
 * @typedef {object} LedgerAuthorizationObservation
 * @property {true} observed
 * @property {string} [actor] The login or component that observed it.
 * @property {string} [workflow] The worker workflow a completion callback
 *   arrived from.
 */

/**
 * @typedef {LedgerAuthorizationDecision | LedgerAuthorizationObservation} LedgerAuthorization
 */

/**
 * @typedef {object} LedgerAnomaly
 * @property {string} kind
 * @property {unknown} [detail] Deliberately untyped: each anomaly kind
 *   carries its own detail shape, and a consumer must render one without
 *   assuming that shape.
 * @property {string} occurredAt
 * @property {import('./failure.js').FailureClassification} [failure] The
 *   owning-system/phase/reason/retry vocabulary (#645), layered onto the
 *   pre-existing free-form `kind`/`detail` rather than replacing them.
 *   Optional because every anomaly recorded before this field existed has
 *   none, and `isWellFormedAnomaly` must keep accepting those unchanged.
 */

/**
 * @typedef {object} LedgerControl
 * @property {boolean} closed
 * @property {string} [sourceId]
 * @property {string} [occurredAt]
 * @property {boolean} [merged]
 */

/**
 * @typedef {object} DispatchLedger
 * @property {string} schema
 * @property {number} revision
 * @property {LedgerTaskRef} task
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {LedgerControl} control
 * @property {LedgerSource[]} sources
 * @property {LedgerGeneration[]} generations
 * @property {LedgerAnomaly[]} anomalies
 */

/**
 * The comment envelope. Both the marker and the fenced JSON block are part of
 * the wire contract: the marker is how either side finds the comment among
 * dozens, and "exactly one JSON block" is how both sides refuse to guess when
 * a comment has been tampered with or a second marker has appeared.
 */
// No `\s*` padding around the capture, deliberately. The obvious spelling —
// /```json\s*([\s\S]*?)\s*```/ — is a polynomial-ReDoS (CodeQL
// js/polynomial-redos): `\s*` and the lazy `[\s\S]*?` can both match the same
// whitespace, so a body starting with "```json" followed by many spaces gives
// the engine quadratically many ways to split them. That matters here because
// the input is a GitHub comment body — attacker-controlled, and parsed
// server-side by the console while rendering a dashboard.
//
// Capturing the fence contents verbatim is unambiguous and equivalent:
// JSON.parse ignores leading and trailing whitespace, so the padding was never
// load-bearing.
const LEDGER_JSON_BLOCK_RE = /```json([\s\S]*?)```/gu;

/**
 * Render a ledger comment. `summary` is the human-readable line shown above
 * the collapsed machine state — the writer computes it, because what is worth
 * summarizing is broker policy, but the envelope around it is contract.
 *
 * @param {DispatchLedger} ledger
 * @param {string} summary
 * @returns {string}
 */
export function renderLedgerComment(ledger, summary) {
  return `${LEDGER_MARKER}\n${summary}\n\n<details><summary>Machine state</summary>\n\n\`\`\`json\n${JSON.stringify(ledger)}\n\`\`\`\n\n</details>`;
}

/**
 * @typedef {{ ok: true, ledger: unknown }
 *   | { ok: false, reason: 'no-marker' }
 *   | { ok: false, reason: 'block-count', blocks: number }
 *   | { ok: false, reason: 'invalid-json' }} LedgerCommentExtraction
 */

/**
 * Pull the machine state out of a ledger comment, without judging it.
 *
 * Returns a result rather than throwing so both callers can build on it: the
 * broker turns any failure into a thrown error, the console turns each into a
 * distinct warning. `ledger` is `unknown` on success — extraction proves the
 * comment carried one JSON block, nothing about what is in it.
 *
 * @param {unknown} body
 * @returns {LedgerCommentExtraction}
 */
export function extractLedgerComment(body) {
  if (typeof body !== 'string' || !body.includes(LEDGER_MARKER)) {
    return { ok: false, reason: 'no-marker' };
  }
  const matches = [...body.matchAll(LEDGER_JSON_BLOCK_RE)];
  if (matches.length !== 1) {
    return { ok: false, reason: 'block-count', blocks: matches.length };
  }
  try {
    return { ok: true, ledger: JSON.parse(matches[0][1]) };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
}

/**
 * Whether a comment body carries the ledger marker at all. An issue predating
 * the broker rollout is expected to have none, which is not an anomaly.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function hasLedgerMarker(body) {
  return body.includes(LEDGER_MARKER);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) > 0;
}

// Widened to `string` deliberately: this set exists to answer "is this
// arbitrary parsed value one of the known states", which a `Set` of the
// literal union would refuse to be asked.
const GENERATION_STATES = /** @type {ReadonlySet<string>} */ (
  new Set(LEDGER_GENERATION_STATES)
);

/**
 * Per-element shape check for one `generations` entry.
 *
 * This guards a real crash, not a hypothetical one: consumers dereference
 * `state`/`generation`/`pipeline`/`intentId`/`sourceId`/`occurredAt`
 * unguarded, trusting that whatever survived the ledger-level check has this
 * shape. Verifying only that `generations` was an array let a ledger with
 * `generations: [null]`, or a generation missing `state`, through — and it
 * crashed rendering downstream instead of degrading.
 *
 * @param {unknown} value
 * @returns {value is LedgerGeneration}
 */
export function isWellFormedGeneration(value) {
  if (!isPlainObject(value)) return false;
  if (!isPositiveInteger(value.generation)) return false;
  if (!isNonEmptyString(value.intentId)) return false;
  if (!isNonEmptyString(value.sourceId)) return false;
  if (!isNonEmptyString(value.occurredAt)) return false;
  if (
    typeof value.pipeline !== 'string' ||
    !isDispatchPipeline(value.pipeline)
  ) {
    return false;
  }
  if (typeof value.state !== 'string' || !GENERATION_STATES.has(value.state)) {
    return false;
  }
  // `attempt` is optional, but a non-object value here would still signal a
  // corrupted ledger even though no consumer reads its fields unguarded.
  if (value.attempt !== undefined && !isPlainObject(value.attempt)) {
    return false;
  }
  return true;
}

/**
 * @param {unknown} value
 * @returns {value is LedgerSource}
 */
export function isWellFormedSource(value) {
  if (!isPlainObject(value)) return false;
  return isNonEmptyString(value.sourceKind) && isNonEmptyString(value.sourceId);
}

/**
 * @param {unknown} value
 * @returns {value is LedgerAnomaly}
 */
export function isWellFormedAnomaly(value) {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.kind) || !isNonEmptyString(value.occurredAt)) {
    return false;
  }
  // `failure` is optional -- every anomaly recorded before #645 has none,
  // and that must keep reading as well-formed rather than rejecting older
  // ledgers. When present, only its gross shape is checked: a non-object
  // would crash a consumer that reads `failure.owningSystem` etc. unguarded
  // (describeLedgerAnomaly in the console). Full vocabulary validation
  // (are `owningSystem`/`phase`/`reason` actually known values?) is the
  // writer's job -- `classifyFailure` already refuses to construct an
  // invalid one -- not this read-side structural gate's.
  if (value.failure !== undefined && !isPlainObject(value.failure)) {
    return false;
  }
  return true;
}

/**
 * Structural validation: loose enough that an older ledger still reads, strict
 * enough that a foreign or corrupted comment is never trusted as ledger data.
 *
 * This is deliberately NOT the writer's full gate — it does not enforce
 * active/pending cardinality or cross-check the numeric `repositoryId`, both
 * of which the broker must enforce and a read path has no cheap way to. A
 * caller that needs those layers them on top.
 *
 * @param {unknown} value
 * @returns {value is DispatchLedger}
 */
export function isWellFormedLedger(value) {
  if (!isPlainObject(value)) return false;
  if (value.schema !== LEDGER_SCHEMA) return false;
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
    return false;
  }
  if (!isPlainObject(value.task)) return false;
  if (!isNonEmptyString(value.task.repository)) return false;
  if (!isPositiveInteger(value.task.issue)) return false;
  // `repositoryId` is checked for presence and shape, not identity. The type
  // guard declares a `LedgerTaskRef` with a required numeric `repositoryId`,
  // so letting a ledger without one through would hand every downstream
  // consumer `undefined` from a field the compiler promised was a number --
  // and it is the field that survives a repository rename, which is the one
  // job the `repository` string cannot do. Cross-checking it against the
  // task the caller expected stays the caller's decision; the writer's
  // `assertTaskRef` has always required it, so nothing the broker has ever
  // written is rejected by this.
  if (!isPositiveInteger(value.task.repositoryId)) return false;
  if (!Array.isArray(value.sources) || !Array.isArray(value.generations)) {
    return false;
  }
  if (!Array.isArray(value.anomalies)) return false;
  if (!isPlainObject(value.control)) return false;
  if (!value.generations.every(isWellFormedGeneration)) return false;
  if (!value.sources.every(isWellFormedSource)) return false;
  if (!value.anomalies.every(isWellFormedAnomaly)) return false;
  return true;
}
