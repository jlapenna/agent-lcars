import type { WatchedRepo } from './watched-repo';

/**
 * Applies an optional GitHub repository filter to host-scoped sessions.
 *
 * A session without a repository is still valid (for example, a CLI session
 * running on a host). It belongs on the unfiltered console, but cannot belong
 * to any selected GitHub repository.
 */
export function filterSessionsForRepo<T extends { repo?: WatchedRepo }>(
  sessions: T[],
  repoFilter: WatchedRepo | undefined,
): T[] {
  if (!repoFilter) return sessions;

  return sessions.filter(
    (session) =>
      session.repo !== undefined &&
      session.repo.owner === repoFilter.owner &&
      session.repo.name === repoFilter.name,
  );
}
