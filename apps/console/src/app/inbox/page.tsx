import { Anchor } from '@mantine/core';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../auth';
import type { ActionItem } from '../../lib/action-items';
import {
  getCachedAgentActivity,
  getCachedQueueItems,
  oldestFetchedAt,
} from '../../lib/dashboard-data';
import {
  getWatchedRepos,
  parseRepoFilterParam,
  repoDisplayName,
  repoKey,
  type WatchedRepo,
} from '../../lib/github-client';
import { getNativeInboxCards } from '../../lib/native-inbox';
import { derivePrimaryAction } from '../../lib/primary-action';
import { buildQueueView } from '../../lib/queue-view';
import { getRunnerSessionsByRunId } from '../../lib/runner-sessions';
import type { BoardCard } from '../board-card';
import { DataWarnings } from '../console-header';
import { ConsoleWorkspace } from '../console-workspace';
import { DataFreshness } from '../data-freshness';
import { DecisionInbox } from '../decision-inbox';
import { formatRelativeTime } from '../format';
import {
  type InboxCard,
  inboxCardKey,
  inboxCardMetadata,
  inboxDecisionRunId,
} from '../inbox-card';
import { InboxNotificationsWatch } from '../inbox-notifications';
import { LiveDashboard } from '../live-dashboard';
import { NavSuspense } from '../nav-suspense';
import { NavPageLoading, PageLoading } from '../page-loading';
import { QueueConsoleUtilities } from '../queue-console-utilities';
import { RepositorySelector } from '../repository-selector';
import { withConsolePageShell } from '../with-console-page-shell';
import { replyToWorkItem } from '../work/actions';
import { context as workContext } from '../work/context';

interface PageProps {
  searchParams: Promise<{ repo?: string; item?: string }>;
}

function toCard(item: ActionItem): BoardCard {
  return {
    item,
    primaryAction: derivePrimaryAction(item),
  };
}

async function InboxBody({
  repoFilter,
  selectedItemKey,
  mobileScopeLabel,
  watchedRepos,
}: {
  repoFilter: WatchedRepo | undefined;
  selectedItemKey?: string;
  mobileScopeLabel: string;
  watchedRepos: WatchedRepo[];
}) {
  const snapshotStartedAt = new Date().toISOString();
  const activityRead = getCachedAgentActivity();
  const [
    {
      data: { items },
      fetchedAt: itemsFetchedAt,
    },
    { data: activity, fetchedAt: activityFetchedAt },
    { sessionsByRunId, warnings: runnerSessionWarnings },
    nativeCards,
  ] = await Promise.all([
    getCachedQueueItems(),
    activityRead,
    activityRead.then(({ data }) =>
      getRunnerSessionsByRunId([...data.liveRuns, ...data.recentRuns]),
    ),
    workContext().then((context) =>
      getNativeInboxCards(
        context.runtime.store,
        context.principal,
        selectedItemKey,
      ),
    ),
  ]);
  const warnings = Array.from(
    new Set([...activity.warnings, ...runnerSessionWarnings]),
  );
  const queueView = buildQueueView(items, activity, sessionsByRunId);
  const matchesFilter = (repo: { owner: string; name: string }) =>
    !repoFilter || repoKey(repo) === repoKey(repoFilter);
  const allCards = [...queueView.items.map(toCard), ...nativeCards];
  const selectedCard = selectedItemKey
    ? allCards.find(
        (card) =>
          matchesFilter(inboxCardMetadata(card).repo) &&
          inboxCardKey(card) === selectedItemKey,
      )
    : undefined;
  const decisionCards = [
    ...queueView.yourQueue.map(toCard),
    ...nativeCards.filter((card) => card.queued),
  ].filter((card) => matchesFilter(inboxCardMetadata(card).repo));

  const trajectoryRunIds = new Set(
    (selectedCard ? [selectedCard] : selectedItemKey ? [] : decisionCards)
      .map(inboxDecisionRunId)
      .filter((id): id is string => id !== undefined),
  );
  const missingRuns = [...trajectoryRunIds]
    .filter((id) => !sessionsByRunId.has(id))
    .map((id) => ({ id }));
  const olderSessions = missingRuns.length
    ? (await getRunnerSessionsByRunId(missingRuns)).sessionsByRunId
    : undefined;
  function withTrajectory<T extends InboxCard>(card: T): T {
    const runId = inboxDecisionRunId(card);
    if (!runId || !trajectoryRunIds.has(runId)) return card;
    const session = sessionsByRunId.get(runId) ?? olderSessions?.get(runId);
    return session ? { ...card, trajectorySessionId: session.sessionId } : card;
  }

  const dataAsOf = oldestFetchedAt(itemsFetchedAt, activityFetchedAt);

  return (
    <ConsoleWorkspace
      ariaLabel="Inbox workspace"
      className="inbox-frame"
      warnings={<DataWarnings warnings={warnings} />}
    >
      <DecisionInbox
        sourceObservations={{
          native: { source: snapshotStartedAt },
          github: {
            queue: itemsFetchedAt,
            activity: activityFetchedAt,
            sessions: snapshotStartedAt,
          },
        }}
        yourQueue={decisionCards.map(withTrajectory)}
        replyToWorkItem={replyToWorkItem}
        selectedCard={selectedCard && withTrajectory(selectedCard)}
        selectedItemKey={selectedItemKey}
        mobileDataFreshness={
          <DataFreshness
            fetchedAt={dataAsOf}
            initialLabel={formatRelativeTime(dataAsOf)}
            dataTestId="mobile-data-freshness"
            compact
          />
        }
        mobileScopeLabel={mobileScopeLabel}
        repoScoped={repoFilter !== undefined}
        toolbarStart={
          <RepositorySelector
            repos={watchedRepos}
            selected={repoFilter ? repoKey(repoFilter) : undefined}
            action="/inbox"
          />
        }
        toolbarEnd={
          <>
            <InboxNotificationsWatch />
            <div className="inbox-data-freshness">
              <DataFreshness
                fetchedAt={dataAsOf}
                initialLabel={formatRelativeTime(dataAsOf)}
              />
            </div>
          </>
        }
      />
    </ConsoleWorkspace>
  );
}

interface InboxViewProps {
  watchedRepos: ReturnType<typeof getWatchedRepos>;
  repoFilter: ReturnType<typeof parseRepoFilterParam>;
  repoFilterKey?: string;
  selectedItemKey?: string;
  subtitle: string;
}

function InboxViewContent({
  watchedRepos,
  repoFilter,
  selectedItemKey,
  subtitle,
}: InboxViewProps) {
  return (
    <>
      <LiveDashboard />
      <NavSuspense fallback={<PageLoading rows={6} header={false} />}>
        <InboxBody
          repoFilter={repoFilter}
          selectedItemKey={selectedItemKey}
          mobileScopeLabel={subtitle}
          watchedRepos={watchedRepos}
        />
      </NavSuspense>
    </>
  );
}

const InboxView = withConsolePageShell(
  InboxViewContent,
  ({ watchedRepos, repoFilter, repoFilterKey, subtitle }) => ({
    className: 'inbox-page-shell',
    current: 'inbox',
    title: 'Decision Inbox',
    repoFilter: repoFilterKey,
    subtitle: (
      <>
        Pending decisions and completed reports · {subtitle}
        {repoFilter && (
          <>
            {' · '}
            <Anchor href="/inbox" size="sm">
              show all repos
            </Anchor>
          </>
        )}
      </>
    ),
    utilities: (
      <>
        <div className="inbox-utilities inbox-utilities--desktop console-utilities--desktop">
          <QueueConsoleUtilities
            watchedRepos={watchedRepos}
            repoFilter={repoFilterKey}
          />
        </div>
        <div className="inbox-utilities inbox-utilities--mobile console-utilities--mobile">
          <QueueConsoleUtilities
            watchedRepos={watchedRepos}
            repoFilter={repoFilterKey}
            includeNavigation
          />
        </div>
      </>
    ),
  }),
);

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
    <InboxView
      watchedRepos={watchedRepos}
      repoFilter={repoFilter}
      repoFilterKey={repoFilterKey}
      selectedItemKey={params.item || undefined}
      subtitle={subtitle}
    />
  );
}

export default function InboxPage({ searchParams }: PageProps) {
  return (
    <NavSuspense
      fallback={
        <NavPageLoading
          current="inbox"
          title="Decision Inbox"
          className="inbox-page-shell"
          rows={6}
        />
      }
    >
      <InboxPageShell searchParams={searchParams} />
    </NavSuspense>
  );
}
