import { Group } from '@mantine/core';

import type { WatchedRepo } from '../lib/watched-repo';
import { repoScopedConsoleHrefs } from './console-header';
import { QueueUtilityMenu } from './queue-utility-menu';
import { QuickTaskButton } from './quick-task-button';
import { RefreshButton } from './refresh-button';
import { SignOutButton } from './sign-out-button';

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
    <Group gap={4} wrap="nowrap">
      <QuickTaskButton watchedRepos={watchedRepos} size="compact-xs" />
      <RefreshButton compact bustsGithubCache />
      <QueueUtilityMenu
        includeNavigation={includeNavigation}
        navigationHrefs={repoScopedConsoleHrefs(repoFilter)}
        signOutControl={<SignOutButton />}
      />
    </Group>
  );
}
