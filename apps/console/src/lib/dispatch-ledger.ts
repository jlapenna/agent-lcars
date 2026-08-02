import type { AgentPipeline } from './watched-repo';

/**
 * Read-side mirror of `.github/actions/dispatch-broker/broker.mjs`'s ledger
 * schema (`agent-lcars.dispatch-ledger/v1`). The broker is the sole writer;
 * this file only ever reads the comment it pins to an issue/PR
 * (`pinLedgerWhenUnoccupied`) and turns it into typed data for the console's
 * view models (see `logical-work.ts`).
 *
 * Deliberately re-derives the marker/schema constants and a lenient parser
 * rather than importing broker.mjs directly: that file lives under
 * `.github/actions/dispatch-broker` (a separate Node ESM package with no
 * relationship to this Next app's build), and the broker's own
 * `validateLedger` throws on anything it doesn't like - exactly the wrong
 * behavior for a read path that must degrade a malformed/older ledger to
 * "no ledger" instead of crashing the dashboard (see `parseDispatchLedger`'s
 * own doc comment).
 */

export const LEDGER_MARKER = '<!-- agent-lcars:dispatch-ledger:v1 -->';
const LEDGER_SCHEMA = 'agent-lcars.dispatch-ledger/v1';

/** Mirrors broker.mjs's ACTIVE_STATES - every state a generation can be in
 * while it still has (or is about to have) a live workflow attempt. */
export const LEDGER_ACTIVE_GENERATION_STATES = new Set([
  'dispatching',
  'dispatch-unknown',
  'active',
  'completion-observed',
  'completion-awaiting-terminal',
]);

export type LedgerGenerationState =
  | 'accepted'
  | 'pending'
  | 'dispatching'
  | 'dispatch-unknown'
  | 'dispatch-rejected'
  | 'active'
  | 'completion-observed'
  | 'completion-awaiting-terminal'
  | 'completed'
  | 'superseded'
  | 'superseded-by-close';

export interface LedgerRunAttempt {
  runId?: number;
  runUrl?: string;
  htmlUrl?: string;
  status?: string;
  conclusion?: string;
  dispatchStartedAt?: string;
  boundAt?: string;
  completedAt?: string;
}

export interface LedgerGeneration {
  generation: number;
  intentId: string;
  sourceId: string;
  occurredAt: string;
  pipeline: AgentPipeline;
  mode?: string;
  runbook?: string;
  state: LedgerGenerationState;
  attempt?: LedgerRunAttempt;
}

export interface LedgerSource {
  sourceKind: string;
  sourceId: string;
  transportRunId?: number;
  occurredAt: string;
}

export interface LedgerAnomaly {
  kind: string;
  /** broker.mjs's `addAnomaly(ledger, kind, detail)` takes an arbitrary
   * JSON-serializable value - every real call site (e.g. `main.mjs`'s
   * `duplicate-attempt`: `{ generation, runIds }`) passes a plain object,
   * never a string. Untyped rather than a specific shape: new anomaly kinds
   * (the reconciler in #305 adds several) carry their own detail shapes
   * this file has no reason to know in advance - see
   * `logical-work.ts`'s `describeLedgerAnomaly` for how a caller safely
   * renders one without assuming its shape. */
  detail?: unknown;
  occurredAt: string;
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
  task: { repository: string; issue: number };
  createdAt: string;
  updatedAt: string;
  control: LedgerControl;
  sources: LedgerSource[];
  generations: LedgerGeneration[];
  anomalies: LedgerAnomaly[];
}

/** `ledger.sources` entry whose `sourceId` produced a given generation - the
 * "why does this generation exist" evidence (a label add, a maintainer
 * reply, the router's own `opened` event, ...). Undefined when the ledger
 * predates the generation carrying source evidence, or the source was
 * pruned - callers must treat that as "unknown," never assume `labeled`. */
export function sourceKindForGeneration(
  ledger: DispatchLedger,
  generation: LedgerGeneration,
): string | undefined {
  return ledger.sources.find(
    (source) => source.sourceId === generation.sourceId,
  )?.sourceKind;
}

const SINGLE_JSON_BLOCK_RE = /```json\s*([\s\S]*?)\s*```/gu;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const PIPELINES = new Set<AgentPipeline>(['claude', 'codex', 'opencode']);

const LEDGER_GENERATION_STATES = new Set<LedgerGenerationState>([
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

/**
 * Per-element shape check for one `ledger.generations` entry. This is the
 * fix for a real crash, not just a defensive nicety: `logical-work.ts`'s
 * `stateForGeneration`/`intentsFromLedger`/`selectedPipeline` all dereference
 * `generation.state`/`.generation`/`.pipeline`/`.intentId`/`.sourceId`/
 * `.occurredAt` unguarded, trusting that anything that survived
 * `isWellFormedLedger` has this shape. Before this check, `isWellFormedLedger`
 * only verified `generations` was an *array* - a real (not just crafted)
 * malformed ledger with e.g. `generations: [null]` or a generation missing
 * `state` passed validation and then crashed rendering downstream.
 */
function isWellFormedGeneration(value: unknown): value is LedgerGeneration {
  if (!isPlainObject(value)) return false;
  if (
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) <= 0
  ) {
    return false;
  }
  if (!isNonEmptyString(value.intentId)) return false;
  if (!isNonEmptyString(value.sourceId)) return false;
  if (!isNonEmptyString(value.occurredAt)) return false;
  if (!PIPELINES.has(value.pipeline as AgentPipeline)) return false;
  if (!LEDGER_GENERATION_STATES.has(value.state as LedgerGenerationState)) {
    return false;
  }
  // `attempt` is optional, but if present must at least be an object -
  // logical-work.ts never reads its fields directly today, but a
  // non-object value here would still be a sign of a corrupted ledger.
  if (value.attempt !== undefined && !isPlainObject(value.attempt)) {
    return false;
  }
  return true;
}

function isWellFormedSource(value: unknown): value is LedgerSource {
  if (!isPlainObject(value)) return false;
  return isNonEmptyString(value.sourceKind) && isNonEmptyString(value.sourceId);
}

function isWellFormedAnomaly(value: unknown): value is LedgerAnomaly {
  if (!isPlainObject(value)) return false;
  return isNonEmptyString(value.kind) && isNonEmptyString(value.occurredAt);
}

/**
 * Structural validation only loose enough to keep a malformed/foreign
 * comment from being trusted as ledger data - NOT broker.mjs's full
 * `validateLedger` (which also enforces active/pending cardinality and a
 * numeric `repositoryId` the console doesn't have a cheap way to
 * cross-check here). A ledger that fails this still means "no ledger for
 * this task," never a thrown error - see `parseDispatchLedger`.
 *
 * Validates every element of `generations`/`sources`/`anomalies`, not just
 * that the fields themselves are arrays: a single malformed element (a
 * `null`, or a generation missing `state`) is just as untrustworthy as a
 * malformed top-level shape, and letting it through used to crash
 * `logical-work.ts`'s consumers instead of degrading like every other
 * malformed-ledger case.
 */
function isWellFormedLedger(value: unknown): value is DispatchLedger {
  if (!isPlainObject(value)) return false;
  if (value.schema !== LEDGER_SCHEMA) return false;
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    return false;
  }
  if (!isPlainObject(value.task)) return false;
  const task = value.task as Record<string, unknown>;
  if (typeof task.repository !== 'string' || task.repository.length === 0) {
    return false;
  }
  if (!Number.isSafeInteger(task.issue) || (task.issue as number) <= 0) {
    return false;
  }
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

export interface ParseLedgerResult {
  ledger?: DispatchLedger;
  /** Set when the comment carries the marker but the JSON block that
   * follows it could not be trusted - a genuinely different failure mode
   * from "no ledger comment at all" (no marker present), which returns
   * `{}` with no warning: an issue predating the dispatch broker rollout is
   * expected to have neither. */
  warning?: string;
}

/** The task the caller expects a ledger comment to belong to - i.e. the
 * exact issue whose comment window was scanned. Same shape as
 * `DispatchLedger['task']` (broker.mjs's `"owner/name"` string form)
 * deliberately, so comparing the two is a plain equality check. */
export interface ExpectedTask {
  repository: string;
  issue: number;
}

function taskLabel(task: ExpectedTask): string {
  return `${task.repository}#${task.issue}`;
}

/**
 * Lenient ledger-comment parser for the console's read path. Unlike
 * broker.mjs's `parseLedgerComment` (which throws - correct for a writer
 * that must never act on a ledger it cannot trust), this degrades every
 * failure to `{ warning }` so one malformed/legacy comment only blanks that
 * one task's dispatch-lineage view, matching the "warnings degrade, never
 * blank the dashboard" convention the rest of this app follows (see
 * `item-enrichment.ts`).
 *
 * `expectedTask` must match the parsed ledger's own `task` field
 * (case-insensitive on the repository, exact on the issue number - mirrors
 * broker.mjs's own `validateLedger` cross-check). Without this, a
 * structurally valid ledger comment copy-pasted from a *different*
 * issue/repo (or, more realistically, a comment a maintainer pastes while
 * debugging) would be accepted and displayed as if it belonged to the
 * task whose comment window produced it.
 */
export function parseDispatchLedger(
  commentBody: string,
  expectedTask: ExpectedTask,
): ParseLedgerResult {
  if (!commentBody.includes(LEDGER_MARKER)) return {};

  const label = taskLabel(expectedTask);
  const matches = [...commentBody.matchAll(SINGLE_JSON_BLOCK_RE)];
  if (matches.length !== 1) {
    return {
      warning: `Malformed dispatch ledger for ${label} (expected one JSON block, found ${matches.length}).`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0][1]);
  } catch {
    return {
      warning: `Malformed dispatch ledger for ${label} (invalid JSON).`,
    };
  }

  if (!isWellFormedLedger(parsed)) {
    return {
      warning: `Malformed dispatch ledger for ${label} (unexpected shape).`,
    };
  }

  if (
    parsed.task.repository.toLowerCase() !==
      expectedTask.repository.toLowerCase() ||
    parsed.task.issue !== expectedTask.issue
  ) {
    return {
      warning: `Dispatch ledger for ${label} actually references ${taskLabel(parsed.task)} - ignoring it rather than misattributing it.`,
    };
  }

  return { ledger: parsed };
}

/**
 * Scans an item's comment window for the pinned ledger comment. GitHub only
 * ever lets one comment be pinned, so exactly one match is the expected
 * case; scanning backwards (matching `action-items.ts`'s
 * `TAKEOVER_COMMAND_RE` precedent) means a stray second marker - itself
 * exactly the kind of anomaly the epic's test matrix calls out - still
 * resolves to the newest evidence rather than the oldest.
 */
export function findLedgerCommentBody(
  comments: { body: string }[],
): string | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].body.includes(LEDGER_MARKER)) return comments[i].body;
  }
  return undefined;
}
