import { Group } from '@mantine/core';

import { consoleRepositoryUrl } from '../lib/deployment';
import type { QuickTaskSourceIdentity } from '../lib/quick-task-evidence';
import type { WatchedRepo } from '../lib/watched-repo';
import type { NavKey } from './console-navigation';
import { QueueUtilityMenu } from './queue-utility-menu';
import { QuickTaskButton } from './quick-task-button';
import { RefreshButton } from './refresh-button';
import { SignOutButton } from './sign-out-button';

/**
 * The compact command cluster that accompanies the shared page header.
 *
 * It centralizes the utility hierarchy (create, refresh, then secondary
 * actions) while allowing each route to supply its precise repository scope,
 * authoritative-queue refresh policy, source evidence, and mobile navigation
 * links.
 */
export function ConsoleCommandUtilities({
  watchedRepos,
  initialRepoKey,
  sourceIdentities,
  refreshesAuthoritativeQueue = false,
  includeNavigation = false,
  includeQuickTask = true,
  navigationHrefs,
}: {
  watchedRepos: WatchedRepo[];
  initialRepoKey?: string;
  sourceIdentities?: QuickTaskSourceIdentity[];
  refreshesAuthoritativeQueue?: boolean;
  includeNavigation?: boolean;
  /** Both of Quick task's submission paths require an admin - `createQuickTask`
   *  calls `requireAdmin()` and `/api/quick-task/v1` checks `isAdmin` - so a
   *  route that admits non-admins must not offer the control to them; the
   *  button would be enabled and every submission would 403. Every other
   *  console destination is admin-gated at the page, which is why this
   *  defaults to true; `/work` is the exception (see its own doc comment) and
   *  passes the session's admin status through. */
  includeQuickTask?: boolean;
  navigationHrefs?: Partial<Record<NavKey, string>>;
}) {
  return (
    <Group gap={4} wrap="nowrap">
      {includeQuickTask && (
        <QuickTaskButton
          watchedRepos={watchedRepos}
          initialRepoKey={initialRepoKey}
          sourceIdentities={sourceIdentities}
          size="compact-xs"
        />
      )}
      <RefreshButton
        compact
        refreshesAuthoritativeQueue={refreshesAuthoritativeQueue}
      />
      <QueueUtilityMenu
        repositoryUrl={consoleRepositoryUrl()}
        includeNavigation={includeNavigation}
        navigationHrefs={navigationHrefs}
        signOutControl={<SignOutButton />}
      />
    </Group>
  );
}
