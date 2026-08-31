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
  navigationHrefs,
}: {
  watchedRepos: WatchedRepo[];
  initialRepoKey?: string;
  sourceIdentities?: QuickTaskSourceIdentity[];
  refreshesAuthoritativeQueue?: boolean;
  includeNavigation?: boolean;
  navigationHrefs?: Partial<Record<NavKey, string>>;
}) {
  return (
    <Group gap={4} wrap="nowrap">
      <QuickTaskButton
        watchedRepos={watchedRepos}
        initialRepoKey={initialRepoKey}
        sourceIdentities={sourceIdentities}
        size="compact-xs"
      />
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
