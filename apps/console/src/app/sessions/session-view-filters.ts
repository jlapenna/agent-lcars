import type { SessionRow } from '../../lib/session-archive';
import { matchesSessionFind } from '../../lib/session-find';

/** Within-window view filter (not an archive query param): find. The agent
 * filter is the archive query's own `agent` (session-archive.ts). */
export interface SessionsViewFilters {
  q?: string;
}

type RawParam = string | string[] | undefined;

/** Next hands a repeated parameter (`?q=a&q=b`) over as an array; the first
 * value wins, as in the archive's own parser. */
function first(value: RawParam): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseViewFilters(searchParams: {
  q?: RawParam;
}): SessionsViewFilters {
  const q = first(searchParams.q)?.trim().slice(0, 128) || undefined;
  return { ...(q && { q }) };
}

/** Carries the view filters into a link, so switching views keeps them. */
export function setViewFilterParams(
  params: URLSearchParams,
  filters: SessionsViewFilters,
): void {
  if (filters.q) params.set('q', filters.q);
}

export function matchesSessionView(
  row: SessionRow,
  filters: SessionsViewFilters,
): boolean {
  return matchesSessionFind(row, filters.q);
}
