import { Anchor, Box, Container, Group } from '@mantine/core';
import { Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../auth';
import type { ActionItem } from '../../lib/action-items';
import {
  getCachedActionItems,
  getCachedAgentActivity,
} from '../../lib/dashboard-data';
import {
  getWatchedRepos,
  parseRepoFilterParam,
  repoDisplayName,
  repoKey,
  type WatchedRepo,
} from '../../lib/github-client';
import { derivePrimaryAction } from '../../lib/primary-action';
import { buildQueueView } from '../../lib/queue-view';
import { getRunnerSessionsByRunId } from '../../lib/runner-sessions';
import { type BoardCard, DecisionInbox } from '../action-items-board';
import {
  ConsoleHeader,
  DataWarnings,
  repoScopedConsoleHrefs,
} from '../console-header';
import { formatCompactRelativeTime } from '../format';
import { PageLoading } from '../page-loading';
import { QueueUtilityMenu } from '../queue-utility-menu';
import { QuickTaskButton } from '../quick-task-button';
import { RefreshButton } from '../refresh-button';
import { SignOutButton } from '../sign-out-button';

interface PageProps {
  searchParams: Promise<{ repo?: string; item?: string }>;
}

function toCard(item: ActionItem): BoardCard {
  return {
    item,
    updatedAtLabel: formatCompactRelativeTime(item.updatedAt),
    primaryAction: derivePrimaryAction(item),
  };
}

async function InboxBody({
  repoFilter,
  selectedItemKey,
}: {
  repoFilter: WatchedRepo | undefined;
  selectedItemKey?: string;
}) {
  const [
    {
      data: { items, warnings: itemWarnings },
    },
    { data: activity },
    { sessionsByRunId, warnings: runnerSessionWarnings },
  ] = await Promise.all([
    getCachedActionItems(),
    getCachedAgentActivity(),
    getRunnerSessionsByRunId(),
  ]);
  const warnings = Array.from(
    new Set([...itemWarnings, ...activity.warnings, ...runnerSessionWarnings]),
  );
  const queueView = buildQueueView(items, activity, sessionsByRunId);
  const matchesFilter = (repo: { owner: string; name: string }) =>
    !repoFilter || repoKey(repo) === repoKey(repoFilter);

  return (
    <>
      {warnings.length > 0 && (
        <Box mb="xl">
          <DataWarnings warnings={warnings} />
        </Box>
      )}
      <DecisionInbox
        yourQueue={queueView.yourQueue
          .filter((item) => matchesFilter(item.repo))
          .map(toCard)}
        selectedItemKey={selectedItemKey}
        repoFilter={repoFilter ? repoKey(repoFilter) : undefined}
      />
    </>
  );
}

function InboxUtilities({
  watchedRepos,
  repoFilter,
  includeNavigation = false,
}: {
  watchedRepos: ReturnType<typeof getWatchedRepos>;
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

async function InboxPageShell({ searchParams }: PageProps) {
  const session = await auth();
  assertAdmin(session, '/login');

  const watchedRepos = getWatchedRepos();
  const params = await searchParams;
  const repoFilter = parseRepoFilterParam(params.repo);
  const repoFilterKey = repoFilter ? repoKey(repoFilter) : undefined;
  const subtitle =
    watchedRepos.length <= 1
      ? repoDisplayName(watchedRepos[0])
      : repoFilter
        ? repoDisplayName(repoFilter)
        : `${watchedRepos.length} repos`;

  return (
    <Container size="xl" py="xl" className="inbox-page-shell">
      <ConsoleHeader
        current="inbox"
        title="Decision Inbox"
        repoFilter={repoFilterKey}
        subtitle={
          <>
            {subtitle}
            {repoFilter && (
              <>
                {' · '}
                <Anchor href="/inbox" size="sm">
                  show all repos
                </Anchor>
              </>
            )}
          </>
        }
        utilities={
          <>
            <div className="inbox-utilities inbox-utilities--desktop">
              <InboxUtilities
                watchedRepos={watchedRepos}
                repoFilter={repoFilterKey}
              />
            </div>
            <div className="inbox-utilities inbox-utilities--mobile">
              <InboxUtilities
                watchedRepos={watchedRepos}
                repoFilter={repoFilterKey}
                includeNavigation
              />
            </div>
          </>
        }
      />

      <Suspense fallback={<PageLoading rows={6} header={false} />}>
        <InboxBody
          repoFilter={repoFilter}
          selectedItemKey={params.item || undefined}
        />
      </Suspense>
    </Container>
  );
}

export default function InboxPage({ searchParams }: PageProps) {
  return (
    <Suspense fallback={<PageLoading rows={6} />}>
      <InboxPageShell searchParams={searchParams} />
    </Suspense>
  );
}
