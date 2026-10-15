/** The fields of a session row FIND reads (session-archive.ts's SessionRow);
 * declared here so the archive can import this without a cycle. */
interface FindableSessionRow {
  sessionId: string;
  title?: string;
  runId?: string;
  host?: string;
  issueNumber?: number;
  repo?: { owner: string; name: string };
  prUrls: readonly { number: number }[];
}

/**
 * FIND over what a session row shows: session and run ids, title, host,
 * issue, repository and pull requests. Shared by /sessions (narrowing its
 * rows) and /costs (narrowing the sessions its ledger sums).
 */
export function matchesSessionFind(
  row: FindableSessionRow,
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
