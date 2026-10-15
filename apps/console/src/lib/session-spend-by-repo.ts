import type { SessionDoc } from '@agent-lcars/telemetry';

import { repoKey } from './github-client';
import { docCost } from './session-ledger';

export const NO_REPOSITORY = '(no repository)';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface RepositorySpendRow {
  /** `owner/name`, or {@link NO_REPOSITORY} for host-scoped CLI sessions. */
  repo: string;
  /** Known spend of sessions active since 00:00 UTC today. */
  todayUsd: number;
  /** Known spend of sessions active in the last seven days. */
  sevenDayUsd: number;
  /** Sessions active in the last seven days. */
  sessions7d: number;
  /** `sevenDayUsd / sessions7d`; undefined with no sessions. */
  perSessionUsd?: number;
  /** Some of the known spend is estimated from model rates. */
  estimated: boolean;
  /** Sessions in the seven-day slice with no reported or estimable cost. */
  unpriced: number;
}

export interface RepositorySpend {
  rows: RepositorySpendRow[];
  todayUsd: number;
  /** Some of `todayUsd` is estimated from model rates. */
  todayEstimated: boolean;
  /** `todayUsd` split by the UTC hour of each session's last activity, one
   * entry per hour from 00:00 through the current hour; it sums to
   * `todayUsd`. */
  todayByHourUsd: number[];
  /** The archive window is shorter than a day (the one-hour window), so the
   * UTC-day figures would undercount and are withheld. */
  todayUnavailable: boolean;
  sevenDayUsd: number;
  /** The archive window is shorter than seven days, so the seven-day
   * figures would undercount and are withheld. */
  sevenDayUnavailable: boolean;
}

function startOfUtcDay(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * Spend by repository for the cost ledger's "Spend by repository" table
 * (design/fleet-console.html#costs). Uses the same per-session cost as every
 * other ledger figure (`docCost`: reported, else estimated from model rates),
 * attributed to the session's last activity: the same "whole cumulative
 * spend of sessions active in the window" semantics as the spend summary,
 * not billed spend incurred within the window.
 */
export function aggregateSpendByRepository(
  docs: readonly SessionDoc[],
  nowMs: number,
  windowDays: number,
): RepositorySpend {
  const todayStart = startOfUtcDay(nowMs);
  const weekStart = nowMs - 7 * DAY_MS;
  const sevenDayUnavailable = windowDays < 7;
  const todayUnavailable = windowDays < 1;
  const byRepo = new Map<string, RepositorySpendRow>();
  let todayUsd = 0;
  let todayEstimated = false;
  const todayByHourUsd: number[] = Array.from(
    { length: Math.floor((nowMs - todayStart) / HOUR_MS) + 1 },
    () => 0,
  );
  let sevenDayUsd = 0;

  for (const doc of docs) {
    const activity = Date.parse(doc.lastActivityAt);
    if (Number.isNaN(activity) || activity < weekStart) continue;
    const key = doc.repo ? repoKey(doc.repo) : NO_REPOSITORY;
    const row = byRepo.get(key) ?? {
      repo: key,
      todayUsd: 0,
      sevenDayUsd: 0,
      sessions7d: 0,
      estimated: false,
      unpriced: 0,
    };
    const cost = docCost(doc);
    row.sessions7d++;
    if (cost.costUsd === undefined) row.unpriced++;
    else {
      row.sevenDayUsd += cost.costUsd;
      sevenDayUsd += cost.costUsd;
      if (cost.estimated) row.estimated = true;
      if (activity >= todayStart) {
        row.todayUsd += cost.costUsd;
        todayUsd += cost.costUsd;
        // A session last active after `nowMs` (clock skew) counts as now.
        const hour = Math.min(
          todayByHourUsd.length - 1,
          Math.floor((activity - todayStart) / HOUR_MS),
        );
        todayByHourUsd[hour] = (todayByHourUsd[hour] ?? 0) + cost.costUsd;
        if (cost.estimated) todayEstimated = true;
      }
    }
    byRepo.set(key, row);
  }

  const rows = [...byRepo.values()]
    .map((row) => ({
      ...row,
      ...(row.sessions7d > 0 && {
        perSessionUsd: row.sevenDayUsd / row.sessions7d,
      }),
    }))
    .sort(
      (a, b) => b.sevenDayUsd - a.sevenDayUsd || a.repo.localeCompare(b.repo),
    );
  return {
    rows,
    todayUsd,
    todayEstimated,
    todayByHourUsd,
    todayUnavailable,
    sevenDayUsd,
    sevenDayUnavailable,
  };
}
