import type { SessionRow } from './session-archive';
import { repoItemKey, type WatchedRepo } from './watched-repo';

export interface IssueSessionGroup {
  /** Mirrors IssueLedgerRow.issueNumber (session-ledger.ts): the issue-agent
   * session's `issueNumber`, or the 'no-issue' catch-all for every CLI
   * session and any issue-agent session missing one (legacy docs). */
  issueNumber: number | 'no-issue';
  /** Undefined only for the 'no-issue' bucket - see IssueLedgerRow.repo's
   * doc comment for why that one stays a single cross-repo catch-all. */
  repo?: WatchedRepo;
  issueUrl?: string;
  /** Newest-first, inherited from `rows`' own order (getSessionArchive's
   * `listSessionDocs` sort) - never re-sorted within the group. */
  sessions: SessionRow[];
}

function groupKey(row: SessionRow): string {
  return row.issueNumber !== undefined
    ? repoItemKey(row.repo, row.issueNumber)
    : 'no-issue';
}

/**
 * Groups an already-fetched, newest-activity-first session row list
 * (SessionArchiveResult.rows) by the issue each session belongs to, for the
 * archive's "group by issue" view (#177) - the complement of
 * aggregateSessionLedger's per-issue cost rollup (session-ledger.ts), which
 * only ever surfaces totals, never the underlying sessions themselves.
 *
 * Deliberately does no sorting of its own: a `Map`'s iteration order is
 * insertion order, and since `rows` already arrives newest-first, the first
 * row seen for a given issue is that issue's own most recent session - so
 * preserving first-seen order for the group list is already "issues ranked
 * by their most recent activity", for free. Keyed by
 * `repoItemKey(repo, issueNumber)`, not the bare issue number, so two
 * watched repos each with their own #42 land in separate groups (the same
 * repo-scoping session-ledger.ts's byIssue rollup already applies).
 */
export function groupSessionsByIssue(rows: SessionRow[]): IssueSessionGroup[] {
  const groups = new Map<string, IssueSessionGroup>();

  for (const row of rows) {
    const key = groupKey(row);
    const existing = groups.get(key);
    if (existing) {
      existing.sessions.push(row);
      continue;
    }
    groups.set(key, {
      issueNumber: row.issueNumber ?? 'no-issue',
      ...(row.issueNumber !== undefined && { repo: row.repo }),
      ...(row.issueUrl !== undefined && { issueUrl: row.issueUrl }),
      sessions: [row],
    });
  }

  return Array.from(groups.values());
}
