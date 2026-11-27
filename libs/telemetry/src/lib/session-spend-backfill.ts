/** Counters from a `backfillSessionSpend` dry run, plus whether it resumed from
 * a document-id cursor. Only a run that started at the beginning has counts for
 * the whole window; a resumed run reports just the suffix after its cursor. */
export interface SpendBackfillCoverage {
  resumed: boolean;
  stale: number;
  unusable: number;
}

/**
 * Operator-facing verdict for a spend-backfill dry run. A clean suffix is not
 * coverage of the window: the skipped prefix may still hold stale or unpriced
 * sessions, so the whole-window verdict is reserved for a scan whose counters
 * actually include the prefix. `unusable` is counted separately from `stale`
 * because those sessions are absent from an indexed total rather than wrong in
 * it; both must be zero (or be reconciled against the ledger) before cutover.
 */
export function spendBackfillCoverageVerdict({
  resumed,
  stale,
  unusable,
}: SpendBackfillCoverage): string {
  if (resumed) {
    return (
      `Suffix-only result (--start-after): ${stale} stale, ${unusable} without readable usage in the scanned suffix. ` +
      'This is not a whole-window coverage verdict; rerun without a cursor or add the prefix counts before cutover.'
    );
  }
  return stale === 0 && unusable === 0
    ? 'Indexed totals are covered for this window.'
    : 'Totals cutover is not covered: stale and unusable must both be 0 (or reconciled against the ledger).';
}
