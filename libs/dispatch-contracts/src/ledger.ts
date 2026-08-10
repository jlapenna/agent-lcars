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
import { z } from 'zod';

import type { FailureClassification } from './failure';
import { isWellFormedFailureClassification } from './failure';
import type { DispatchOutcomeKind, DispatchOutcomeReference } from './outcomes';
import { isDispatchOutcomeKind, isDispatchOutcomeReference } from './outcomes';
import type { DispatchPipeline } from './pipelines';
import { isDispatchPipeline } from './pipelines';
import type { ProjectionStatus } from './projection';
import { isWellFormedProjectionStatus } from './projection';

export const LEDGER_MARKER = '<!-- agent-lcars:dispatch-ledger:v1 -->';
export const LEDGER_SCHEMA = 'agent-lcars.dispatch-ledger/v1';

/**
 * Every state a generation can be in, in lifecycle order.
 *
 * Declared `const` so the state union below is derived from this one list
 * rather than hand-listed a second time as a type — the same reason the
 * console's copy used to pair a `_LIST` with a `(typeof ...)[number]`.
 */
export const LEDGER_GENERATION_STATES = [
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
] as const;

export type LedgerGenerationState = (typeof LEDGER_GENERATION_STATES)[number];

/**
 * The states in which a generation still has, or is about to have, a live
 * workflow attempt. The broker enforces at most one generation in this set at
 * a time, which is what makes "the active generation" well defined.
 */
export const LEDGER_ACTIVE_GENERATION_STATES: ReadonlySet<string> = new Set([
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
 */
export interface LedgerTaskRef {
  repositoryId: number;
  /** `owner/name`. */
  repository: string;
  issue: number;
}

/**
 * One workflow attempt for a generation. Every field past `token` is written
 * by a specific broker transition, so their presence is itself the record of
 * how far the attempt got.
 */
export interface LedgerRunAttempt {
  /** The attempt's stable public identity,
   *   `g<generation>:<intentId>` (see marker.js's `formatAttemptId`). Written
   *   once at `beginDispatch` and never rewritten. This is what the run title's
   *   marker encodes, so it is the join key between a ledger entry and the
   *   GitHub Actions run that executed it. Absent on attempts recorded before
   *   this field existed. */
  attemptId?: string;
  /** Immutable dispatch token minted at
   *   `beginDispatch`, echoed back by the worker's preflight to prove the run
   *   is the one this generation dispatched. */
  token?: string;
  /** Set by `beginDispatch`. */
  dispatchStartedAt?: string;
  /** Set by `bindRun` once the run is identified. */
  runId?: number;
  /** Set by `bindRun`. */
  runUrl?: string;
  /** Set by `bindRun`. */
  htmlUrl?: string;
  /** Set by `bindRun`. */
  boundAt?: string;
  /** Set by `markDispatchUnknown` when the
   *   dispatch response was lost and the run may or may not exist. */
  unknownAt?: string;
  /** Set by `markDispatchUnknown`. */
  unknownReason?: string;
  /** Set by `markDispatchRejected` when the
   *   dispatch definitively did not start. */
  rejectedAt?: string;
  /** Set by `markDispatchRejected`. */
  rejectionReason?: string;
  /** Set by `observeCompletion` from
   *   the worker's own callback — an observation, not yet authority. */
  completionObservedAt?: string;
  /** Set by `awaitTerminal` each time the
   *   run was polled and was not yet terminal. */
  lastObservedAt?: string;
  /** Authoritative run status at `completeRun`. */
  status?: string;
  /** Authoritative run conclusion. */
  conclusion?: string;
  /** Worker-reported lifecycle outcome, independently useful from the
   * coarse GitHub run conclusion. */
  outcome?: DispatchOutcomeKind;
  /** Exact object backing `outcome`, when the verifier could identify one.
   * This stays immutable with the worker result; readers may independently
   * observe that a referenced PR merged later. */
  outcomeReference?: DispatchOutcomeReference;
  /** Authoritative terminal timestamp. */
  completedAt?: string;
}

export interface LedgerGeneration {
  /** 1-based, monotonic within a ledger. */
  generation: number;
  intentId: string;
  /** Joins to the `sources` entry that caused it. */
  sourceId: string;
  occurredAt: string;
  pipeline: DispatchPipeline;
  /** `implement` or `review`. */
  mode?: string;
  runbook?: string;
  /** Routed issue context handed to the agent. */
  context?: string;
  /** The comment body that triggered a reply-mode run. */
  reply?: string;
  /** Semantic digest; a repeat of the same intent ID
   *   with a different digest is a reuse error, not a duplicate. */
  digest?: string;
  state: LedgerGenerationState;
  attempt?: LedgerRunAttempt;
}

/**
 * The evidence for why a generation exists. This is the record the issue's
 * source-of-truth table calls "raw external signal and authorization
 * evidence", so it carries the authorization decision itself, not just a
 * pointer to one.
 */
export interface LedgerSource {
  /** A label add, a maintainer reply, the router's
   *   own `opened` event, and so on. */
  sourceKind: string;
  sourceId: string;
  /** Joins this evidence to the generation it
   *   produced. */
  intentId?: string;
  transportRunId?: number;
  occurredAt: string;
  /** Semantic digest of the intent this evidence
   *   carried, used to detect an intent ID reused with different content. */
  digest?: string;
  /** The decision that admitted
   *   this signal, retained as an audit record. */
  authorization?: LedgerAuthorization;
}

/**
 * A real authorization decision: some actor did something, and policy either
 * admitted it or did not.
 */
export interface LedgerAuthorizationDecision {
  authorized: boolean;
  /** The login whose action produced the signal. */
  actor?: string;
  /** The maintainer login `authorized`
   *   was evaluated against, kept so an old decision stays auditable after the
   *   configured maintainer changes. */
  configuredMaintainer?: string;
  /** Which policy clause decided it. */
  rule?: string;
}

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
 */
export interface LedgerAuthorizationObservation {
  observed: true;
  /** The login or component that observed it. */
  actor?: string;
  /** The worker workflow a completion callback
   *   arrived from. */
  workflow?: string;
}

export type LedgerAuthorization =
  LedgerAuthorizationDecision | LedgerAuthorizationObservation;

export interface LedgerAnomaly {
  kind: string;
  /** Deliberately untyped: each anomaly kind
   *   carries its own detail shape, and a consumer must render one without
   *   assuming that shape. */
  detail?: unknown;
  occurredAt: string;
  /** The
   *   owning-system/phase/reason/retry vocabulary (#645), layered onto the
   *   pre-existing free-form `kind`/`detail` rather than replacing them.
   *   Optional because every anomaly recorded before this field existed has
   *   none, and `isWellFormedAnomaly` must keep accepting those unchanged. */
  failure?: FailureClassification;
}

export interface LedgerControl {
  closed: boolean;
  sourceId?: string;
  occurredAt?: string;
  merged?: boolean;
}

export interface DispatchLedger {
  schema: string;
  revision: number;
  task: LedgerTaskRef;
  createdAt: string;
  updatedAt: string;
  control: LedgerControl;
  sources: LedgerSource[];
  generations: LedgerGeneration[];
  anomalies: LedgerAnomaly[];
  /** The projector's own convergence checkpoint (#645 Phase 4 §5) —
   *  whether GitHub-facing state has caught up with this ledger. Optional
   *  because every ledger written before the projector module existed has
   *  none, and reading one must not treat that absence as an error: it
   *  means "no convergence attempt has been recorded yet", the same as an
   *  explicit `state: 'pending'` would. Deliberately NOT read by any
   *  dispatch/outcome logic — see dispatch-broker's modules/projector.ts,
   *  which is the only writer. */
  projection?: ProjectionStatus;
}

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
 */
export function renderLedgerComment(
  ledger: DispatchLedger,
  summary: string,
): string {
  return `${LEDGER_MARKER}\n${summary}\n\n<details><summary>Machine state</summary>\n\n\`\`\`json\n${JSON.stringify(ledger)}\n\`\`\`\n\n</details>`;
}

export type LedgerCommentExtraction =
  | { ok: true; ledger: unknown }
  | { ok: false; reason: 'no-marker' }
  | { ok: false; reason: 'block-count'; blocks: number }
  | { ok: false; reason: 'invalid-json' };

/**
 * Pull the machine state out of a ledger comment, without judging it.
 *
 * Returns a result rather than throwing so both callers can build on it: the
 * broker turns any failure into a thrown error, the console turns each into a
 * distinct warning. `ledger` is `unknown` on success — extraction proves the
 * comment carried one JSON block, nothing about what is in it.
 */
export function extractLedgerComment(body: unknown): LedgerCommentExtraction {
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
 */
export function hasLedgerMarker(body: string): boolean {
  return body.includes(LEDGER_MARKER);
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const nonEmptyString = z.string().min(1);
const positiveSafeInteger = z.number().int().safe().positive();

/**
 * Per-element schema for one `generations` entry (#884: zod).
 *
 * Loose on purpose, exactly like the hand-rolled predicate it replaced: it
 * checks the fields consumers dereference unguarded and passes everything
 * else through, so every ledger the broker has ever written keeps reading
 * as well-formed. The `check` preserves the old conditional: an
 * `attempt.outcomeReference` is only meaningful on a `pull-request`
 * outcome.
 */
const ledgerGenerationSchema = z
  .looseObject({
    generation: positiveSafeInteger,
    intentId: nonEmptyString,
    sourceId: nonEmptyString,
    occurredAt: nonEmptyString,
    pipeline: z.custom<DispatchPipeline>(
      (value) => typeof value === 'string' && isDispatchPipeline(value),
    ),
    state: z.enum(LEDGER_GENERATION_STATES),
    attempt: z
      .looseObject({
        outcome: z
          .custom<DispatchOutcomeKind>((value) => isDispatchOutcomeKind(value))
          .optional(),
        outcomeReference: z
          .custom<DispatchOutcomeReference>((value) =>
            isDispatchOutcomeReference(value),
          )
          .optional(),
      })
      .optional(),
  })
  .check((ctx) => {
    const attempt = ctx.value.attempt;
    if (
      attempt?.outcomeReference !== undefined &&
      attempt.outcome !== 'pull-request'
    ) {
      ctx.issues.push({
        code: 'custom',
        message: 'outcomeReference requires a pull-request outcome',
        input: attempt.outcomeReference,
        path: ['attempt', 'outcomeReference'],
      });
    }
  });

/**
 * This guards a real crash, not a hypothetical one: consumers dereference
 * `state`/`generation`/`pipeline`/`intentId`/`sourceId`/`occurredAt`
 * unguarded, trusting that whatever survived the ledger-level check has this
 * shape. Verifying only that `generations` was an array let a ledger with
 * `generations: [null]`, or a generation missing `state`, through — and it
 * crashed rendering downstream instead of degrading.
 */
export function isWellFormedGeneration(
  value: unknown,
): value is LedgerGeneration {
  return ledgerGenerationSchema.safeParse(value).success;
}

const ledgerSourceSchema = z.looseObject({
  sourceKind: nonEmptyString,
  sourceId: nonEmptyString,
});

export function isWellFormedSource(value: unknown): value is LedgerSource {
  return ledgerSourceSchema.safeParse(value).success;
}

// `failure` is optional -- every anomaly recorded before #645 has none,
// and those must keep reading as well-formed rather than rejecting older
// ledgers. When present it is validated against the real vocabularies, not
// merely shape-checked: `classifyFailure` refuses to build an invalid
// classification, but that guarantee does not survive a round trip through
// a hand-editable GitHub comment.
const ledgerAnomalySchema = z.looseObject({
  kind: nonEmptyString,
  occurredAt: nonEmptyString,
  failure: z
    .custom<FailureClassification>((value) =>
      isWellFormedFailureClassification(value),
    )
    .optional(),
});

export function isWellFormedAnomaly(value: unknown): value is LedgerAnomaly {
  return ledgerAnomalySchema.safeParse(value).success;
}

/**
 * Structural validation: loose enough that an older ledger still reads, strict
 * enough that a foreign or corrupted comment is never trusted as ledger data.
 *
 * This is deliberately NOT the writer's full gate — it does not enforce
 * active/pending cardinality or cross-check the numeric `repositoryId`, both
 * of which the broker must enforce and a read path has no cheap way to. A
 * caller that needs those layers them on top. `projection` stays optional for
 * the same reason `anomalies[].failure` is: every ledger written before it
 * existed must keep reading as well-formed, but a present-and-malformed value
 * must not reach a consumer as though it were real convergence data.
 */
const dispatchLedgerSchema = z.looseObject({
  schema: z.literal(LEDGER_SCHEMA),
  revision: z.number().int().safe().nonnegative(),
  task: z.looseObject({
    repository: nonEmptyString,
    // `repositoryId` is checked for presence and shape, not identity: it is
    // the field that survives a repository rename, which is the one job the
    // `repository` string cannot do. Cross-checking it against the task the
    // caller expected stays the caller's decision.
    repositoryId: positiveSafeInteger,
    issue: positiveSafeInteger,
  }),
  control: z.looseObject({}),
  sources: z.array(ledgerSourceSchema),
  generations: z.array(ledgerGenerationSchema),
  anomalies: z.array(ledgerAnomalySchema),
  projection: z
    .custom<ProjectionStatus>((value) => isWellFormedProjectionStatus(value))
    .optional(),
});

export function isWellFormedLedger(value: unknown): value is DispatchLedger {
  return dispatchLedgerSchema.safeParse(value).success;
}
