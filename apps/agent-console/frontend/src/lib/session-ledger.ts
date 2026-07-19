import type { SessionDoc } from '@repo/agent-telemetry';

export interface LedgerTotals {
  sessions: number;
  turns: number;
  tokens: number;
  /**
   * Sum of `totalCostUsd` across only the sessions in this bucket that
   * *have* a recorded cost (see SessionDoc.totalCostUsd's doc comment - it's
   * omitted, not zeroed, for a genuinely-unmeasured session). `undefined`
   * when none of the bucket's sessions carried a cost at all, so the caller
   * can render an em-dash instead of a misleading "$0.00" - a bucket mixing
   * measured and unmeasured sessions still gets a real (partial) total, with
   * that partiality called out as a footnote by the renderer, not silently
   * hidden here.
   */
  costUsd?: number;
}

export interface IssueLedgerRow extends LedgerTotals {
  /** The issue-agent session's `issueNumber`, or the literal 'no-issue'
   * bucket for every CLI session (which never carries one) and any
   * issue-agent session missing one (legacy docs predating the field). */
  issueNumber: number | 'no-issue';
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
  /** Same sort as byIssue. */
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

function accumulate<K>(
  buckets: Map<K, LedgerTotals>,
  key: K,
  turns: number,
  tokens: number,
  costUsd: number | undefined,
): void {
  const existing = buckets.get(key);
  const base: LedgerTotals = existing ?? { sessions: 0, turns: 0, tokens: 0 };
  buckets.set(key, {
    sessions: base.sessions + 1,
    turns: base.turns + turns,
    tokens: base.tokens + tokens,
    ...((base.costUsd !== undefined || costUsd !== undefined) && {
      costUsd: (base.costUsd ?? 0) + (costUsd ?? 0),
    }),
  });
}

/**
 * Pure rollup of a set of session docs into per-issue and per-ISO-week cost
 * ledgers, rendered on the /sessions archive page above/below the raw
 * session table. Takes whatever doc set the caller already fetched (the
 * page's `days`/`source`/`issue` window) - this function has no time or
 * network dependency of its own, so it's fully deterministic from its input.
 */
export function aggregateSessionLedger(docs: SessionDoc[]): SessionLedger {
  const byIssueMap = new Map<number | 'no-issue', LedgerTotals>();
  const byWeekMap = new Map<string, LedgerTotals>();

  for (const doc of docs) {
    const tokens = doc.tokens.inputTokens + doc.tokens.outputTokens;
    const issueKey: number | 'no-issue' =
      doc.source === 'issue-agent' && doc.issueNumber !== undefined
        ? doc.issueNumber
        : 'no-issue';
    accumulate(byIssueMap, issueKey, doc.turns, tokens, doc.totalCostUsd);
    accumulate(
      byWeekMap,
      isoWeekKey(doc.startedAt),
      doc.turns,
      tokens,
      doc.totalCostUsd,
    );
  }

  const byIssue = Array.from(byIssueMap.entries())
    .map(([issueNumber, totals]) => ({ issueNumber, ...totals }))
    .sort(compareLedgerTotals);
  const byWeek = Array.from(byWeekMap.entries())
    .map(([isoWeek, totals]) => ({ isoWeek, ...totals }))
    .sort(compareLedgerTotals);

  return { byIssue, byWeek };
}
