import type { WatchedRepo } from '../lib/watched-repo';
import { ConsoleCommandUtilities } from './console-command-utilities';
import { repoScopedConsoleHrefs } from './console-hrefs';

/** Shared Deck/Inbox command controls. Both routes use the same responsive
 * behavior and repository-scoped destinations, so keeping the composition in
 * one place prevents the two command rails from drifting. */
export function QueueConsoleUtilities({
  watchedRepos,
  repoFilter,
  includeNavigation = false,
}: {
  watchedRepos: WatchedRepo[];
  repoFilter?: string;
  includeNavigation?: boolean;
}) {
  return (
    <ConsoleCommandUtilities
      watchedRepos={watchedRepos}
      initialRepoKey={repoFilter}
      bustsGithubCache
      includeNavigation={includeNavigation}
      navigationHrefs={repoScopedConsoleHrefs(repoFilter)}
    />
  );
}
