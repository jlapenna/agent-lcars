import {
  type DispatchLedger,
  type DispatchPipeline,
  extractLedgerComment,
  hasLedgerMarker,
  isPlainObject,
  isWellFormedLedger,
  LEDGER_ACTIVE_GENERATION_STATES,
  LEDGER_MARKER,
  type LedgerAnomaly,
  type LedgerControl,
  type LedgerGeneration,
  type LedgerRunAttempt,
  type LedgerSource,
} from '@agent-lcars/dispatch-contracts';

/**
 * Read-side consumer of `@agent-lcars/dispatch-contracts`' ledger schema
 * (`agent-lcars.dispatch-ledger/v1`). `broker.mjs` is the sole writer; this
 * file only ever reads the comment it pins to an issue/PR
 * (`pinLedgerWhenUnoccupied`) and turns it into typed data for the console's
 * view models (see `logical-work.ts`).
 *
 * The marker, the schema string, the state vocabulary, the comment envelope,
 * and the record shapes (`DispatchLedger`, `LedgerGeneration`, ...) used to
 * be re-derived here by hand, with this file's own header noting the two
 * packages had "no relationship." They had already drifted: this file's
 * copies were missing `context`/`reply`/`digest` on a generation and
 * `token`/`unknownAt`/`unknownReason`/`rejectedAt`/`rejectionReason`/
 * `completionObservedAt`/`lastObservedAt` on an attempt. Those constants and
 * shapes now come from `libs/dispatch-contracts/src/ledger.js` - import it,
 * do not re-derive it.
 *
 * What is still genuinely different, and deliberately NOT shared, is each
 * side's validation *policy*: the broker's own `validateLedger` throws on
 * anything it doesn't trust - correct for a writer that must fail closed.
 * This file instead degrades a malformed or older ledger to "no ledger"
 * rather than crash a dashboard (see `parseDispatchLedger`'s own doc
 * comment), building that lenient policy on the shared `isWellFormedLedger`
 * predicate rather than the broker's strict gate.
 */

export { isPlainObject, LEDGER_ACTIVE_GENERATION_STATES, LEDGER_MARKER };
export type {
  DispatchLedger,
  LedgerAnomaly,
  LedgerControl,
  LedgerGeneration,
  LedgerRunAttempt,
  LedgerSource,
};

/** Every pipeline the broker can persist. `canary` is the trusted no-op
 * production probe, not a selectable coding-agent integration. Kept as a
 * console-local alias of the shared `DispatchPipeline` typedef since
 * existing callers reference it by this name. */
export type LedgerPipeline = DispatchPipeline;

/** Every state a ledger generation can be in - the shared package's own
 * `LedgerGeneration['state']` field type. Kept as a console-local alias
 * since existing callers reference it by this name. */
export type LedgerGenerationState = LedgerGeneration['state'];

/** A ledger's own `task` field (the shared package's `LedgerTaskRef`, which
 * also carries `repositoryId`), and also the shape a caller passes in to
 * name the task it expects a scanned comment window to belong to (see
 * `parseDispatchLedger`) - deliberately narrower than the ledger's own
 * `task`: a caller only ever asserts what it already knows (repository +
 * issue), never the numeric `repositoryId` a GraphQL/REST fetch would have
 * to look up separately just to compare. */
export interface ExpectedTask {
  repository: string;
  issue: number;
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

export interface ParseLedgerResult {
  ledger?: DispatchLedger;
  /** Set when the comment carries the marker but the JSON block that
   * follows it could not be trusted - a genuinely different failure mode
   * from "no ledger comment at all" (no marker present), which returns
   * `{}` with no warning: an issue predating the dispatch broker rollout is
   * expected to have neither. */
  warning?: string;
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
 * Built on the shared `extractLedgerComment`, which only proves the comment
 * carried exactly one JSON block - each of its non-`ok` `reason`s is mapped
 * to this file's own warning text below, and a successful extraction is
 * still passed through `isWellFormedLedger` before being trusted.
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
  const extraction = extractLedgerComment(commentBody);
  if (!extraction.ok) {
    if (extraction.reason === 'no-marker') return {};

    const label = taskLabel(expectedTask);
    if (extraction.reason === 'block-count') {
      return {
        warning: `Malformed dispatch ledger for ${label} (expected one JSON block, found ${extraction.blocks}).`,
      };
    }
    // extraction.reason === 'invalid-json'
    return {
      warning: `Malformed dispatch ledger for ${label} (invalid JSON).`,
    };
  }

  const label = taskLabel(expectedTask);
  const parsed = extraction.ledger;
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
    if (hasLedgerMarker(comments[i].body)) return comments[i].body;
  }
  return undefined;
}
