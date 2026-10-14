import type { SessionRow } from './session-archive';

/**
 * FIND over what a session row shows: session and run ids, title, host,
 * issue, repository and pull requests. Shared by /sessions (narrowing its
 * rows) and /costs (narrowing the sessions its ledger sums).
 */
export function matchesSessionFind(
  row: SessionRow,
  q: string | undefined,
): boolean {
  if (!q) return true;
  const haystack = [
    row.sessionId,
    row.title,
    row.runId,
    row.host,
    row.issueNumber === undefined ? undefined : `#${row.issueNumber}`,
    row.repo ? `${row.repo.owner}/${row.repo.name}` : undefined,
    ...row.prUrls.map((pr) => `#${pr.number}`),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(q.toLowerCase());
}
