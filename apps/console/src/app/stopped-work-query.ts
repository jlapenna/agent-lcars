import type { TaskListCursor } from '@agent-lcars/orchestrator';

/** The store cursor is a timestamp plus a tie-breaking task key. */
export function parseStoppedWorkCursor(
  raw?: string,
): TaskListCursor | undefined {
  if (!raw) return undefined;
  if (raw.length > 1024) throw new Error('Stopped work cursor is too long.');
  const cursor: unknown = JSON.parse(raw);
  if (
    typeof cursor !== 'object' ||
    cursor === null ||
    !('taskKey' in cursor) ||
    typeof cursor.taskKey !== 'string' ||
    !cursor.taskKey ||
    !('updatedAt' in cursor) ||
    typeof cursor.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(cursor.updatedAt))
  )
    throw new Error('Invalid stopped work cursor.');
  return { taskKey: cursor.taskKey, updatedAt: cursor.updatedAt };
}

export function stoppedWorkHref(repo?: string, cursor?: TaskListCursor) {
  const query = new URLSearchParams();
  if (repo) query.set('repo', repo);
  if (cursor) query.set('stoppedCursor', JSON.stringify(cursor));
  return `/${query.size ? `?${query}` : ''}`;
}
