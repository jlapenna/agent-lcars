import { logger } from '@agent-lcars/logging';
import type { TaskListCursor } from '@agent-lcars/orchestrator';
import type { WorkSummary } from '@agent-lcars/work/derive';
import { Anchor, Box } from '@mantine/core';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';
import { consoleLandingPath } from '@/lib/console-access';
import {
  excludeClosedGithubAnchors,
  listWorkSummaries,
} from '@/lib/work-summary';

import { auth } from '../auth';
import type { ActionItem } from '../lib/action-items';
import { getCliSessions } from '../lib/cli-sessions';
import {
  getCachedAgentActivity,
  getCachedQueueItems,
  oldestFetchedAt,
} from '../lib/dashboard-data';
import {
  getWatchedRepos,
  parseRepoFilterParam,
  repoDisplayName,
  repoItemKey,
  repoKey,
  type WatchedRepo,
} from '../lib/github-client';
import { getNativeInboxEvidence } from '../lib/native-inbox';
import { derivePrimaryAction } from '../lib/primary-action';
import { buildQueueView } from '../lib/queue-view';
import { indexSessionsByRunId } from '../lib/run-classification';
import { getRunnerSessionsByRunId } from '../lib/runner-sessions';
import { filterSessionsForRepo } from '../lib/session-repo-filter';
import { type BoardCard, BridgeSections } from './action-items-board';
import {
  AgentActivityPanel,
  isActiveCliSession,
  RECENT_OUTCOMES_LIMIT,
  type RunItemRef,
} from './agent-activity-panel';
import { BridgeDetail } from './bridge-detail';
import { resolveBridgeDetail } from './bridge-rows';
import { parseBridgeSelection } from './bridge-selection';
import { DataWarnings } from './console-header';
import { repoScopedConsoleHrefs } from './console-hrefs';
import { DataFreshness } from './data-freshness';
import { DeckInboxSummary } from './deck-inbox-summary';
import { formatRelativeTime } from './format';
import { inboxCardMetadata } from './inbox-card';
import { LiveDashboard } from './live-dashboard';
import { NavPageLoading, PageLoading } from './page-loading';
import { ParkedWorkPanel } from './parked-work-panel';
import { QueueConsoleUtilities } from './queue-console-utilities';
import { RepositorySelector } from './repository-selector';
import { parseStoppedWorkCursor, stoppedWorkHref } from './stopped-work-query';
import { withConsolePageShell } from './with-console-page-shell';
import { cancelItem, redispatchItem } from './work/actions';
import { context as workContext } from './work/context';

function toCard(item: ActionItem): BoardCard {
  return {
    item,
    primaryAction: derivePrimaryAction(item),
  };
}

/**
 * Reads a bounded page of the all-anchor work summary projection from the
 * orchestrator, rather than deriving parked state from a GitHub label or
 * limiting itself to native work ids. GitHub remains a detail enrichment
 * surface; it is not the state authority for this panel. The existing Work
 * operator grant gates it before native controls can render.
 *
 * Fetched in `IndexBody`'s own `Promise.all` (rather than a separately
 * Suspense-isolated slot) so the resolved items are also available to
 * `resolveBridgeDetail` - a "Stopped work" row's `?sel=` must resolve to the
 * *same* item the list renders, matching every other Bridge row kind.
 */
async function getParkedWork(
  repo?: string,
  rawCursor?: string,
): Promise<{
  items: WorkSummary[];
  hasMoreTasks: boolean;
  nextCursor?: TaskListCursor;
  error?: string;
}> {
  try {
    const work = await workContext();
    if (!work.principal?.scopes.has('work.operator')) {
      return { items: [], hasMoreTasks: false };
    }
    const page = await listWorkSummaries(work.runtime.store, {
      limit: 200,
      cursor: parseStoppedWorkCursor(rawCursor),
    });
    const items = await excludeClosedGithubAnchors(
      work.runtime.store,
      page.items.filter(
        (item) =>
          (item.state === 'parked' || item.state === 'failed') &&
          (!repo || item.spec.target.repo === repo),
      ),
    );
    return {
      items,
      hasMoreTasks: page.nextCursor !== undefined,
      nextCursor: page.nextCursor,
    };
  } catch (error) {
    // The Bridge must never fall to error.tsx because this panel's fetch
    // failed. Keep the rest of the Bridge available and disclose the failed
    // read with a reset link rather than presenting it as an empty queue.
    logger.error('agent-lcars: parked work panel unavailable:', error);
    return {
      items: [],
      hasMoreTasks: false,
      error:
        'Could not load stopped work. Retry or reset the stopped-work page.',
    };
  }
}

interface PageProps {
  searchParams: Promise<{
    repo?: string;
    sel?: string;
    stoppedCursor?: string;
  }>;
}

async function IndexBody({
  repoFilter,
  repoFilterKey,
  selectedKey,
  stoppedCursor,
  multiRepo,
}: {
  repoFilter: WatchedRepo | undefined;
  repoFilterKey?: string;
  selectedKey?: string;
  stoppedCursor?: string;
  multiRepo: boolean;
}) {
  const [
    {
      data: { items: rawItems },
      fetchedAt: itemsFetchedAt,
    },
    { data: activity, fetchedAt: activityFetchedAt },
    { sessions: cliSessions, warnings: cliSessionWarnings },
    { sessionsByRunId: runnerSessionsByRunId, warnings: runnerSessionWarnings },
    {
      items: parkedWorkItems,
      hasMoreTasks: hasMoreParkedTasks,
      nextCursor: stoppedNextCursor,
      error: stoppedError,
    },
    nativeInbox,
  ] = await Promise.all([
    getCachedQueueItems(),
    getCachedAgentActivity(),
    getCliSessions(),
    getRunnerSessionsByRunId(),
    getParkedWork(repoFilterKey, stoppedCursor),
    getNativeInboxEvidence(async () => {
      const context = await workContext();
      return { store: context.runtime.store, principal: context.principal };
    }),
  ]);
  // Deduped: independent authoritative reads can fail independently, and
  // each unique problem only needs saying once.
  const warnings = Array.from(
    new Set([
      ...activity.warnings,
      ...cliSessionWarnings,
      ...runnerSessionWarnings,
      ...nativeInbox.warnings,
    ]),
  );

  // run.id -> joined session doc, for every run this page renders (live and
  // recent alike) - powers the In Flight budget gauges and the Recent
  // Outcomes classification/diagnosis (see agent-activity-panel.tsx).
  const sessionsByRunId = indexSessionsByRunId(
    [...activity.liveRuns, ...activity.recentRuns],
    runnerSessionsByRunId,
  );

  const queueView = buildQueueView(rawItems, activity, runnerSessionsByRunId);

  // The reverse join: live runs annotated with the item they're working, so
  // the In Flight panel can link the issue instead of the raw run title.
  const itemsByRunId: Record<string, RunItemRef> = {};
  for (const item of queueView.items) {
    const run = queueView.liveRunByItemKey.get(
      repoItemKey(item.repo, item.number),
    );
    if (run) {
      itemsByRunId[run.id] = {
        number: item.number,
        title: item.title,
        url: item.url,
      };
    }
  }

  // Applied last, after every cross-repo join above (itemsByRunId,
  // liveRunFor, silent-error diagnoses) already ran against the full,
  // unfiltered data - a repo filter should narrow what's *displayed*, never
  // which items can see each other's runs/sessions. The repository selector
  // and scoped navigation share this same `?repo=` state.
  const matchesFilter = (repo: { owner: string; name: string }) =>
    !repoFilter || repoKey(repo) === repoKey(repoFilter);
  const filteredActivity = repoFilter
    ? {
        ...activity,
        liveRuns: activity.liveRuns.filter((run) => matchesFilter(run.repo)),
        recentRuns: activity.recentRuns.filter((run) =>
          matchesFilter(run.repo),
        ),
      }
    : activity;
  const filteredCliSessions = filterSessionsForRepo(cliSessions, repoFilter);

  const dataAsOf = oldestFetchedAt(itemsFetchedAt, activityFetchedAt);

  const deployCards = queueView.waitingOnDeploy
    .filter((i) => matchesFilter(i.repo))
    .map((item) => toCard(item));
  const blockedCards = queueView.blocked
    .filter((i) => matchesFilter(i.repo))
    .map((item) => toCard(item));

  // The right pane of the two-panel view (desktop ≥1024px). Resolved from the
  // `?sel=` key against the *same* records the left column actually renders -
  // the same recent-run slice and the same live/idle session filter the
  // operations panel uses - so a row that has scrolled out of the list (a
  // run past the outcome cutoff, a session that ended) resolves to the empty
  // state rather than lingering as detail with no row to select.
  const detail = resolveBridgeDetail({
    selectedKey,
    liveRuns: filteredActivity.liveRuns,
    recentRuns: filteredActivity.recentRuns.slice(0, RECENT_OUTCOMES_LIMIT),
    cliSessions: filteredCliSessions.filter(isActiveCliSession),
    waitingOnDeploy: deployCards,
    blocked: blockedCards,
    parkedWork: parkedWorkItems,
    itemsByRunId,
    sessionsByRunId,
    multiRepo,
  });
  // Base the mobile detail swap on whether a *resolved* row exists, not on the
  // raw `?sel=`: a stale, filtered-out, or malformed key must leave the mobile
  // list visible (its empty state carries no back control to recover to).
  const hasSelection = detail.kind !== 'none';

  return (
    <>
      <DataFreshness
        fetchedAt={dataAsOf}
        initialLabel={formatRelativeTime(dataAsOf)}
      />
      {warnings.length > 0 && (
        <Box mb="xl">
          <DataWarnings warnings={warnings} />
        </Box>
      )}

      <section
        className="bridge-workspace"
        data-sel={hasSelection ? '' : undefined}
      >
        <div className="bridge-workspace__list">
          <DeckInboxSummary
            count={
              queueView.yourQueue.filter((item) => matchesFilter(item.repo))
                .length +
              nativeInbox.cards.filter((card) =>
                matchesFilter(inboxCardMetadata(card).repo),
              ).length
            }
            nativeAvailable={nativeInbox.available}
            inboxHref={repoScopedConsoleHrefs(repoFilterKey)?.inbox ?? '/inbox'}
          />

          <ParkedWorkPanel
            items={parkedWorkItems}
            hasMoreTasks={hasMoreParkedTasks}
            error={stoppedError}
            nextPageHref={
              stoppedNextCursor
                ? stoppedWorkHref(repoFilterKey, stoppedNextCursor)
                : undefined
            }
            firstPageHref={
              stoppedCursor || stoppedError
                ? stoppedWorkHref(repoFilterKey)
                : undefined
            }
            cancel={cancelItem}
            redispatch={redispatchItem}
            repoFilterKey={repoFilterKey}
            stoppedCursor={stoppedCursor}
          />

          <AgentActivityPanel
            activity={filteredActivity}
            cliSessions={filteredCliSessions}
            itemsByRunId={itemsByRunId}
            sessionsByRunId={sessionsByRunId}
            repoFilter={repoFilterKey}
            stoppedCursor={stoppedCursor}
          />

          <BridgeSections
            waitingOnDeploy={deployCards}
            blocked={blockedCards}
            repoFilterKey={repoFilterKey}
            stoppedCursor={stoppedCursor}
          />
        </div>

        <div className="bridge-workspace__detail">
          <BridgeDetail
            detail={detail}
            repoFilterKey={repoFilterKey}
            stoppedCursor={stoppedCursor}
            cancel={cancelItem}
            redispatch={redispatchItem}
          />
        </div>
      </section>
    </>
  );
}

/**
 * Auth-gate, title/subtitle, and nav render eagerly here - none of
 * it needs the slow GitHub/Firestore reads `IndexBody` fetches, so this
 * shell only has to wait on `auth()` and `searchParams` (both fast, no
 * network), not the ~30-request fleet activity fetch. That keeps the header
 * off the streamed placeholder `IndexBody`'s own Suspense boundary shows
 * while its data resolves - see #160.
 */
interface IndexViewProps {
  watchedRepos: ReturnType<typeof getWatchedRepos>;
  repoFilter: ReturnType<typeof parseRepoFilterParam>;
  repoFilterKey?: string;
  selectedKey?: string;
  stoppedCursor?: string;
  multiRepo: boolean;
  subtitle: string;
}

function IndexViewContent({
  watchedRepos,
  repoFilter,
  repoFilterKey,
  selectedKey,
  stoppedCursor,
  multiRepo,
}: IndexViewProps) {
  return (
    <>
      <RepositorySelector
        repos={watchedRepos}
        selected={repoFilter ? repoKey(repoFilter) : undefined}
        action="/"
      />
      <LiveDashboard />
      <Suspense
        key={`${repoFilterKey ?? ''}:${stoppedCursor ?? ''}`}
        fallback={<PageLoading rows={6} header={false} />}
      >
        <IndexBody
          repoFilter={repoFilter}
          repoFilterKey={repoFilterKey}
          selectedKey={selectedKey}
          stoppedCursor={stoppedCursor}
          multiRepo={multiRepo}
        />
      </Suspense>
    </>
  );
}

const IndexView = withConsolePageShell(
  IndexViewContent,
  ({ watchedRepos, repoFilter, repoFilterKey, subtitle }) => ({
    className: 'deck-page-shell',
    current: 'deck',
    title: 'Bridge',
    repoFilter: repoFilterKey,
    subtitle: (
      <>
        {subtitle}
        {repoFilter && (
          <>
            {' · '}
            <Anchor href="/" size="sm">
              show all repos
            </Anchor>
          </>
        )}
      </>
    ),
    utilities: (
      <>
        <div className="deck-utilities deck-utilities--desktop console-utilities--desktop">
          <QueueConsoleUtilities
            watchedRepos={watchedRepos}
            repoFilter={repoFilterKey}
          />
        </div>
        <div className="deck-utilities deck-utilities--mobile console-utilities--mobile">
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

async function IndexShell({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user?.isAdmin && consoleLandingPath(session) === '/work') {
    redirect('/work');
  }
  assertAdmin(session, '/login');

  const watchedRepos = getWatchedRepos();
  const params = await searchParams;

  const repoFilter = parseRepoFilterParam(params.repo);
  const repoFilterKey = repoFilter ? repoKey(repoFilter) : undefined;
  const selectedKey = parseBridgeSelection(params.sel);

  const subtitle =
    watchedRepos.length <= 1
      ? repoDisplayName(watchedRepos[0])
      : repoFilter
        ? repoDisplayName(repoFilter)
        : `${watchedRepos.length} repos`;

  return (
    <IndexView
      watchedRepos={watchedRepos}
      repoFilter={repoFilter}
      repoFilterKey={repoFilterKey}
      selectedKey={selectedKey}
      stoppedCursor={params.stoppedCursor}
      multiRepo={watchedRepos.length > 1}
      subtitle={subtitle}
    />
  );
}

// `cacheComponents` requires uncached data access to sit inside a Suspense
// boundary, so `IndexShell` (auth() + searchParams, both fast) streams in
// behind a 6-row placeholder rather than blocking on those; its own nested
// Suspense around `IndexBody` covers the slow GitHub/Firestore reads
// separately, so the header never waits on those (see #160).
export default function Index({ searchParams }: PageProps) {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="deck"
          title="Bridge"
          className="deck-page-shell"
          rows={6}
        />
      }
    >
      <IndexShell searchParams={searchParams} />
    </Suspense>
  );
}
