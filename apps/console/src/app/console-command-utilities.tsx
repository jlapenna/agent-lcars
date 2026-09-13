import { Group } from '@mantine/core';

import type { ActionItem } from '../lib/action-items';
import { consoleRepositoryUrl } from '../lib/deployment';
import type { QuickTaskSourceIdentity } from '../lib/quick-task-evidence';
import type { WatchedRepo } from '../lib/watched-repo';
import type { NavKey } from './console-navigation';
import { formatRelativeTime } from './format';
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
 * links. Every page that renders the shared header feeds its utilities
 * through this cluster, so the three-dots menu is the one constant control in
 * the header's top-right slot on every destination and drill-down, at every
 * breakpoint.
 */
export function ConsoleCommandUtilities({
  watchedRepos,
  initialRepoKey,
  sourceIdentities,
  refreshesAuthoritativeQueue = false,
  includeNavigation = false,
  includeQuickTask = true,
  navigationHrefs,
  generatedAt,
  item,
}: {
  watchedRepos: WatchedRepo[];
  initialRepoKey?: string;
  sourceIdentities?: QuickTaskSourceIdentity[];
  refreshesAuthoritativeQueue?: boolean;
  includeNavigation?: boolean;
  /** Native creation requires a work.operator grant. Admin-gated routes use
   * the production admin grant by default; `/work` resolves the signed-in
   * principal explicitly because that route also admits ungranted users. */
  includeQuickTask?: boolean;
  navigationHrefs?: Partial<Record<NavKey, string>>;
  /** Detail routes render the real age of their cached sources beside the
   * refresh control; hidden by the shared slot CSS below tablet width. */
  generatedAt?: string;
  /** Detail pages fold that item's overflow actions into the three-dots
   * menu so the header shows exactly one dots trigger (#1676). */
  item?: ActionItem;
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
        generatedAt={generatedAt}
        initialLabel={generatedAt ? formatRelativeTime(generatedAt) : undefined}
      />
      <QueueUtilityMenu
        repositoryUrl={consoleRepositoryUrl()}
        includeNavigation={includeNavigation}
        navigationHrefs={navigationHrefs}
        signOutControl={<SignOutButton />}
        item={item}
      />
    </Group>
  );
}
