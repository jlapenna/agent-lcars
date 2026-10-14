import type { TaskListCursor } from '@agent-lcars/orchestrator';

import type { BridgeView } from './bridge-selection';

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

export function stoppedWorkHref(
  repo?: string,
  cursor?: TaskListCursor,
  view: BridgeView = {},
) {
  const query = new URLSearchParams();
  if (repo) query.set('repo', repo);
  if (view.agent) query.set('agent', view.agent);
  if (view.window) query.set('window', view.window);
  if (view.q) query.set('q', view.q);
  if (cursor) query.set('stoppedCursor', JSON.stringify(cursor));
  return `/${query.size ? `?${query}` : ''}`;
}
