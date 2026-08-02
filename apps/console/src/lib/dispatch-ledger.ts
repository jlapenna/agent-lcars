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
  detail?: string;
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

/**
 * Structural validation only loose enough to keep a malformed/foreign
 * comment from being trusted as ledger data - NOT broker.mjs's full
 * `validateLedger` (which also enforces active/pending cardinality and a
 * numeric `repositoryId` the console doesn't have a cheap way to
 * cross-check here). A ledger that fails this still means "no ledger for
 * this task," never a thrown error - see `parseDispatchLedger`.
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

/**
 * Lenient ledger-comment parser for the console's read path. Unlike
 * broker.mjs's `parseLedgerComment` (which throws - correct for a writer
 * that must never act on a ledger it cannot trust), this degrades every
 * failure to `{ warning }` so one malformed/legacy comment only blanks that
 * one task's dispatch-lineage view, matching the "warnings degrade, never
 * blank the dashboard" convention the rest of this app follows (see
 * `item-enrichment.ts`).
 */
export function parseDispatchLedger(
  commentBody: string,
  taskKey: string,
): ParseLedgerResult {
  if (!commentBody.includes(LEDGER_MARKER)) return {};

  const matches = [...commentBody.matchAll(SINGLE_JSON_BLOCK_RE)];
  if (matches.length !== 1) {
    return {
      warning: `Malformed dispatch ledger for ${taskKey} (expected one JSON block, found ${matches.length}).`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0][1]);
  } catch {
    return {
      warning: `Malformed dispatch ledger for ${taskKey} (invalid JSON).`,
    };
  }

  if (!isWellFormedLedger(parsed)) {
    return {
      warning: `Malformed dispatch ledger for ${taskKey} (unexpected shape).`,
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
