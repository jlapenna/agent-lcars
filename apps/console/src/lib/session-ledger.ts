import type { SessionDoc } from '@agent-lcars/telemetry';
import { estimateCostUsd, totalTokens } from '@agent-lcars/telemetry';

import {
  primaryWatchedRepo,
  repoItemKey,
  type WatchedRepo,
} from './github-client';

export interface LedgerTotals {
  sessions: number;
  turns: number;
  tokens: number;
  /**
   * Sum, across every session in this bucket that has *either* a recorded
   * `totalCostUsd` (see SessionDoc.totalCostUsd's doc comment) *or* a
   * resolvable {@link estimateCostUsd} from its model + token usage - a
   * session with neither (no model recorded, or a model this repo has no
   * published rate for) contributes nothing. `undefined` when no session in
   * the bucket had either, so the caller can render an em-dash instead of a
   * misleading "$0.00" - a bucket mixing costed/estimated and truly-unpriced
   * sessions still gets a real (partial) total, with that partiality called
   * out as a footnote by the renderer, not silently hidden here.
   */
  costUsd?: number;
  /**
   * True when at least one session contributing to `costUsd` came from
   * {@link estimateCostUsd} rather than a recorded `totalCostUsd` - lets the
   * renderer flag a bucket's total as (at least partly) an estimate rather
   * than presenting it as a measured dollar figure. `undefined`/`false`
   * when every contributing session had a recorded cost, or when the bucket
   * has no cost at all.
   */
  costEstimated?: boolean;
}

export interface IssueLedgerRow extends LedgerTotals {
  /** The issue-agent session's `issueNumber`, or the literal 'no-issue'
   * bucket for every CLI session (which never carries one) and any
   * issue-agent session missing one (legacy docs predating the field). */
  issueNumber: number | 'no-issue';
  /**
   * Which repo `issueNumber` belongs to - undefined for the 'no-issue'
   * bucket, which stays a single cross-repo catch-all rather than being
   * split per repo (unlike a real issue number, "no issue" never claims to
   * identify one specific GitHub entity, so mixing repos into it doesn't
   * misattribute anyone's cost - see aggregateSessionLedger). Falls back to
   * primaryWatchedRepo() for docs written before Phase 0's `repo` field
   * existed, same as every other repo-less-doc fallback in this app.
   */
  repo?: WatchedRepo;
}

export interface WeekLedgerRow extends LedgerTotals {
  /** ISO 8601 week string, e.g. "2026-W29" (Monday-start weeks per the ISO
   * definition, not the US Sunday-start convention) - or the literal
   * 'unknown' bucket for a session whose `startedAt` has no parseable
   * timestamp (see SessionSummary.startedAt's '' fallback in reducer.ts). */
  isoWeek: string | 'unknown';
}

export interface SessionLedger {
  /** Sorted by cost desc, then tokens desc (see {@link compareLedgerTotals}) - not capped; the page renders the top N. */
  byIssue: IssueLedgerRow[];
  /** Sorted chronologically, newest ISO week first (see
   * {@link compareWeekKeysDesc}) - unlike byIssue's cost-ranked order, a
   * cost/token ranking would scramble the calendar sequence here, and this
   * is a dashboard where the most recent week is what you want up top. Not
   * capped; the page renders the top N. */
  byWeek: WeekLedgerRow[];
}

/**
 * Cost-first, tokens-as-tiebreak-or-fallback ranking: a bucket with a known
 * cost always outranks one with none (even a large uncosted token bucket),
 * since cost is the more actionable signal once any session in scope has
 * reported one; buckets with no costed sessions at all still rank among
 * themselves by token volume, the best available proxy (mirrors
 * cli-sessions.ts's existing "no cost ledger yet -> token volume is the best
 * available proxy" rationale, now scoped to just the uncosted subset).
 */
function compareLedgerTotals(a: LedgerTotals, b: LedgerTotals): number {
  if (a.costUsd !== undefined && b.costUsd !== undefined) {
    return b.costUsd - a.costUsd || b.tokens - a.tokens;
  }
  if (a.costUsd !== undefined) return -1;
  if (b.costUsd !== undefined) return 1;
  return b.tokens - a.tokens;
}

/**
 * Chronological, newest-first comparator for the per-week rollup: this is a
 * dashboard, so a maintainer wants the most recent week at the top, not
 * buried below however many weeks rank higher by cost/tokens (see
 * {@link compareLedgerTotals}, which is right for byIssue but would scramble
 * byWeek's calendar order). ISO week keys are zero-padded four-digit-year,
 * two-digit-week strings ("2026-W01"), so plain string comparison already
 * orders correctly across a year boundary - "2025-W52" sorts before
 * "2026-W01" because '5' < '6' in the year's third digit, no numeric
 * parsing needed. The 'unknown' bucket (unparseable `startedAt`) has no
 * calendar position, so it's always sorted last regardless of direction.
 */
function compareWeekKeysDesc(a: WeekLedgerRow, b: WeekLedgerRow): number {
  if (a.isoWeek === 'unknown') return b.isoWeek === 'unknown' ? 0 : 1;
  if (b.isoWeek === 'unknown') return -1;
  if (a.isoWeek === b.isoWeek) return 0;
  return a.isoWeek < b.isoWeek ? 1 : -1;
}

/**
 * ISO 8601 week key ("2026-W29") for an ISO timestamp, Monday-start weeks
 * per the standard's own definition (week 1 is the week containing the
 * year's first Thursday). Returns 'unknown' for an unparseable timestamp
 * rather than propagating `NaN` into a bucket key.
 */
function isoWeekKey(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return 'unknown';
  }
  const date = new Date(
    Date.UTC(
      parsed.getUTCFullYear(),
      parsed.getUTCMonth(),
      parsed.getUTCDate(),
    ),
  );
  const mondayIndexedDay = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  date.setUTCDate(date.getUTCDate() - mondayIndexedDay + 3); // nearest Thursday
  const isoYear = date.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const weekNumber = Math.ceil(
    ((date.getTime() - yearStart) / 86_400_000 + 1) / 7,
  );
  return `${isoYear}-W${String(weekNumber).padStart(2, '0')}`;
}

/** A single session's cost contribution to the ledger: its recorded
 * `totalCostUsd` when present, else an {@link estimateCostUsd} from its
 * model + token usage, else no cost at all - see `docCost`. */
interface SessionCost {
  costUsd: number | undefined;
  /** True when `costUsd` came from `estimateCostUsd` rather than a recorded
   * `totalCostUsd`. Meaningless when `costUsd` is undefined. */
  estimated: boolean;
}

/**
 * Resolves a session doc's cost contribution: its own recorded
 * `totalCostUsd` when the transcript reported one, otherwise a published-
 * rate estimate from its `model` + `tokens` (undefined when the model is
 * absent or unrecognized - see {@link estimateCostUsd}'s doc comment for
 * why that's the right fallback rather than treating it as a $0 session).
 */
function docCost(doc: SessionDoc): SessionCost {
  if (doc.totalCostUsd !== undefined) {
    return { costUsd: doc.totalCostUsd, estimated: false };
  }
  return { costUsd: estimateCostUsd(doc.model, doc.tokens), estimated: true };
}

function accumulateTotals(
  base: LedgerTotals,
  turns: number,
  tokens: number,
  cost: SessionCost,
): LedgerTotals {
  return {
    sessions: base.sessions + 1,
    turns: base.turns + turns,
    tokens: base.tokens + tokens,
    ...((base.costUsd !== undefined || cost.costUsd !== undefined) && {
      costUsd: (base.costUsd ?? 0) + (cost.costUsd ?? 0),
    }),
    ...((base.costEstimated ||
      (cost.costUsd !== undefined && cost.estimated)) && {
      costEstimated: true,
    }),
  };
}

function accumulate<K>(
  buckets: Map<K, LedgerTotals>,
  key: K,
  turns: number,
  tokens: number,
  cost: SessionCost,
): void {
  const existing = buckets.get(key);
  const base: LedgerTotals = existing ?? { sessions: 0, turns: 0, tokens: 0 };
  buckets.set(key, accumulateTotals(base, turns, tokens, cost));
}

/**
 * Pure rollup of a set of session docs into per-issue and per-ISO-week cost
 * ledgers, rendered on the /sessions archive page above/below the raw
 * session table. Takes whatever doc set the caller already fetched (the
 * page's `days`/`source`/`issue` window) - this function has no time or
 * network dependency of its own, so it's fully deterministic from its input.
 */
export function aggregateSessionLedger(docs: SessionDoc[]): SessionLedger {
  // Keyed by repoItemKey(repo, issueNumber), NOT the bare issue number - two
  // watched repos can each have their own #42, and merging them into one
  // row would misattribute one repo's cost onto the other's issue (the
  // same class of bug Codex caught as a React key collision in the board -
  // see #18). The 'no-issue' catch-all is the one deliberate exception
  // (see IssueLedgerRow.repo's doc comment): it stays a single bucket
  // across every repo.
  const byIssueMap = new Map<
    string,
    LedgerTotals & { issueNumber: number | 'no-issue'; repo?: WatchedRepo }
  >();
  const byWeekMap = new Map<string, LedgerTotals>();

  for (const doc of docs) {
    const tokens = totalTokens(doc.tokens);
    const cost = docCost(doc);
    if (doc.source === 'issue-agent' && doc.issueNumber !== undefined) {
      const repo = doc.repo ?? primaryWatchedRepo();
      const key = repoItemKey(repo, doc.issueNumber);
      const existing = byIssueMap.get(key);
      byIssueMap.set(key, {
        issueNumber: doc.issueNumber,
        repo,
        ...accumulateTotals(
          existing ?? { sessions: 0, turns: 0, tokens: 0 },
          doc.turns,
          tokens,
          cost,
        ),
      });
    } else {
      const existing = byIssueMap.get('no-issue');
      byIssueMap.set('no-issue', {
        issueNumber: 'no-issue',
        ...accumulateTotals(
          existing ?? { sessions: 0, turns: 0, tokens: 0 },
          doc.turns,
          tokens,
          cost,
        ),
      });
    }
    accumulate(byWeekMap, isoWeekKey(doc.startedAt), doc.turns, tokens, cost);
  }

  const byIssue = Array.from(byIssueMap.values()).sort(compareLedgerTotals);
  const byWeek = Array.from(byWeekMap.entries())
    .map(([isoWeek, totals]) => ({ isoWeek, ...totals }))
    .sort(compareWeekKeysDesc);

  return { byIssue, byWeek };
}
