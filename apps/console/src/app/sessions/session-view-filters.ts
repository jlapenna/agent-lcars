import { SESSION_AGENTS, type SessionAgent } from '@agent-lcars/telemetry';

import type { SessionRow } from '../../lib/session-archive';

/** Within-window view filters (not archive query params): agent and find. */
export interface SessionsViewFilters {
  agent?: SessionAgent;
  q?: string;
}

export function parseViewFilters(searchParams: {
  agent?: string;
  q?: string;
}): SessionsViewFilters {
  const agent = (SESSION_AGENTS as readonly string[]).includes(
    searchParams.agent ?? '',
  )
    ? (searchParams.agent as SessionAgent)
    : undefined;
  const q = searchParams.q?.trim().slice(0, 128) || undefined;
  return { agent, q };
}

export function matchesSessionView(
  row: SessionRow,
  filters: SessionsViewFilters,
): boolean {
  if (filters.agent && row.agent !== filters.agent) return false;
  if (filters.q) {
    const needle = filters.q.toLowerCase();
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
    if (!haystack.includes(needle)) return false;
  }
  return true;
}
