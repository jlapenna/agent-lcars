import type { SessionRow } from '../../lib/session-archive';
import type { IssueSessionGroup } from '../../lib/session-issue-groups';

/**
 * How much of the archive the page renders before the maintainer asks for
 * the rest. A 14-day window holds thousands of sessions; rendering each one
 * as server markup (a table row and a phone card) made the route's RSC
 * payload about 21 MB and its client navigation 40-50 s in production.
 */
export const ARCHIVE_INITIAL_SESSIONS = 200;
/** The newest sessions one issue group shows by default, so a single busy
 * group (most often "no issue" CLI work) cannot fill the window itself. */
export const ARCHIVE_GROUP_ROW_LIMIT = 50;

export interface ArchiveWindow<T> {
  shown: T[];
  /** Sessions in the archive that this window leaves out. */
  hiddenSessions: number;
}

/** The flat view: the first rows, already newest first. */
export function windowFlatRows(
  rows: readonly SessionRow[],
  showAll: boolean,
): ArchiveWindow<SessionRow> {
  const shown = showAll ? [...rows] : rows.slice(0, ARCHIVE_INITIAL_SESSIONS);
  return { shown, hiddenSessions: rows.length - shown.length };
}

/** The by-issue view: whole groups in order until about
 * ARCHIVE_INITIAL_SESSIONS rows are shown, each capped at
 * ARCHIVE_GROUP_ROW_LIMIT. Groups keep every session so their headings
 * count the issue's real total; the renderer applies the row cap. */
export function windowIssueGroups(
  groups: readonly IssueSessionGroup[],
  showAll: boolean,
): ArchiveWindow<IssueSessionGroup> & { rowLimit: number | undefined } {
  if (showAll)
    return { shown: [...groups], hiddenSessions: 0, rowLimit: undefined };
  const shown: IssueSessionGroup[] = [];
  let rendered = 0;
  for (const group of groups) {
    if (shown.length > 0 && rendered >= ARCHIVE_INITIAL_SESSIONS) break;
    shown.push(group);
    rendered += Math.min(group.sessions.length, ARCHIVE_GROUP_ROW_LIMIT);
  }
  const total = groups.reduce((sum, group) => sum + group.sessions.length, 0);
  return {
    shown,
    hiddenSessions: total - rendered,
    rowLimit: ARCHIVE_GROUP_ROW_LIMIT,
  };
}
