import { Anchor, Container } from '@mantine/core';
import { Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../auth';
import { type ActionItem } from '../../lib/action-items';
import { deriveClaimedIdle } from '../../lib/claimed-idle';
import { getCliSessions } from '../../lib/cli-sessions';
import {
  getCachedActionItems,
  getCachedAgentActivity,
  oldestFetchedAt,
} from '../../lib/dashboard-data';
import {
  getWatchedRepos,
  parseRepoFilterParam,
  primaryWatchedRepo,
  repoDisplayName,
  repoItemKey,
  repoKey,
} from '../../lib/github-client';
import { indexSessionsByNumericRunId } from '../../lib/run-classification';
import { getRunnerSessionsByRunId } from '../../lib/runner-sessions';
import type { RunItemRef } from '../agent-activity-panel';
import { ConsoleFooter } from '../console-footer';
import { ConsoleHeader } from '../console-header';
import { formatRelativeTime } from '../format';
import { PageLoading } from '../page-loading';
import { ActiveAgentsSection } from './active-agents-section';
import { ClaimedIdleSection } from './claimed-idle-section';
import { FleetSnapshotBar } from './fleet-snapshot-bar';
import { RecentOutcomesSection } from './recent-outcomes-section';

interface PageProps {
  searchParams: Promise<{ repo?: string }>;
}

async function AgentsPageContent({ searchParams }: PageProps) {
  const session = await auth();
  assertAdmin(session, '/login');

  const watchedRepos = getWatchedRepos();
  const repoFilter = parseRepoFilterParam((await searchParams).repo);
  const matchesFilter = (repo: { owner: string; name: string }) =>
    !repoFilter || repoKey(repo) === repoKey(repoFilter);

  const [
    {
      data: { items, warnings: itemWarnings },
      fetchedAt: itemsAt,
    },
    { data: activity, fetchedAt: activityAt },
    { sessions: cliSessions, warnings: cliSessionWarnings },
    { sessionsByRunId: runnerSessionsByRunId, warnings: runnerSessionWarnings },
  ] = await Promise.all([
    getCachedActionItems(),
    getCachedAgentActivity(),
    getCliSessions(),
    getRunnerSessionsByRunId(),
  ]);
  // Deduped the same way as the home page (page.tsx): parallel fetchers can
  // degrade the same way (e.g. one rate-limit hit per PR-join), and each
  // unique problem only needs saying once.
  const warnings = Array.from(
    new Set([
      ...itemWarnings,
      ...activity.warnings,
      ...cliSessionWarnings,
      ...runnerSessionWarnings,
    ]),
  );

  // run.id -> joined session doc, for every run this page renders (live and
  // recent alike) - powers Active Agents' budget gauges and Recent
  // Outcomes' classification/diagnosis (see agent-activity-panel.tsx).
  const sessionsByRunId = indexSessionsByNumericRunId(
    [...activity.liveRuns, ...activity.recentRuns],
    runnerSessionsByRunId,
  );

  // Same run<->item join as the home page (see its comment for why
  // issueNumber-first with a title fallback is correct) - kept local here
  // rather than shared, since it's a small, self-contained join and this
  // page's item set (all open items) differs from home's per-bucket view.
  const liveRunByNumber = new Map(
    activity.liveRuns
      .filter((run) => run.issueNumber !== undefined)
      .map((run) => [repoItemKey(run.repo, run.issueNumber as number), run]),
  );
  const liveRunByTitle = new Map(
    activity.liveRuns
      .filter((run) => run.issueNumber === undefined)
      .map((run) => [run.displayTitle, run]),
  );
  const liveRunFor = (item: ActionItem) =>
    liveRunByNumber.get(repoItemKey(item.repo, item.number)) ??
    liveRunByTitle.get(item.title);

  const itemsByRunId: Record<number, RunItemRef> = {};
  for (const item of items) {
    const run = liveRunFor(item);
    if (run) {
      itemsByRunId[run.id] = {
        number: item.number,
        title: item.title,
        url: item.url,
      };
    }
  }

  const activeSessions = cliSessions.filter(
    (cliSession) =>
      cliSession.liveness === 'live' || cliSession.liveness === 'idle',
  );

  const claimedIdle = deriveClaimedIdle(
    items,
    (item) => Boolean(liveRunFor(item)),
    activeSessions,
  );

  const generatedAt = oldestFetchedAt(itemsAt, activityAt);

  // Applied last, after every cross-repo join above already ran against the
  // full, unfiltered data - see page.tsx's identical comment for why.
  const filteredItems = items.filter((item) => matchesFilter(item.repo));
  // A doc with no `repo` predates Phase 0's field - session-archive.ts and
  // cli-sessions.ts both already treat that as belonging to the primary
  // repo when building links, so the filter must agree (see page.tsx's
  // identical comment).
  const filteredActiveSessions = activeSessions.filter((s) =>
    matchesFilter(s.repo ?? primaryWatchedRepo()),
  );
  const filteredActivity = repoFilter
    ? {
        ...activity,
        liveRuns: activity.liveRuns.filter((run) => matchesFilter(run.repo)),
        recentRuns: activity.recentRuns.filter((run) =>
          matchesFilter(run.repo),
        ),
      }
    : activity;
  const filteredClaimedIdle = claimedIdle.filter((item) =>
    matchesFilter(item.repo),
  );

  const subtitlePrefix =
    watchedRepos.length <= 1
      ? undefined
      : repoFilter
        ? repoDisplayName(repoFilter)
        : `${watchedRepos.length} repos`;

  return (
    <Container size="xl" py="xl">
      <ConsoleHeader
        current="agents"
        title="Agent Status"
        subtitle={
          <>
            {subtitlePrefix && `${subtitlePrefix} — `}
            Fleet-wide view of every claude/opencode run and CLI session, agent
            by agent.
            {repoFilter && (
              <>
                {' · '}
                <Anchor href="/agents" size="sm">
                  show all repos
                </Anchor>
              </>
            )}
          </>
        }
        warnings={warnings}
      />

      <FleetSnapshotBar
        activity={filteredActivity}
        activeCliSessionCount={filteredActiveSessions.length}
      />

      <ActiveAgentsSection
        liveRuns={filteredActivity.liveRuns}
        itemsByRunId={itemsByRunId}
        activeSessions={filteredActiveSessions}
        items={filteredItems}
        sessionsByRunId={sessionsByRunId}
      />

      <ClaimedIdleSection items={filteredClaimedIdle} />

      <RecentOutcomesSection
        recentRuns={filteredActivity.recentRuns}
        sessionsByRunId={sessionsByRunId}
      />

      <ConsoleFooter
        generatedAt={generatedAt}
        refreshLabel={formatRelativeTime(generatedAt)}
        bustsGithubCache
      />
    </Container>
  );
}

// `cacheComponents` requires uncached data access to sit inside a Suspense
// boundary, so the page body streams in behind 5-row placeholder rather
// than blocking the whole route on the GitHub/Firestore reads.
export default function AgentsPage({ searchParams }: PageProps) {
  return (
    <Suspense fallback={<PageLoading rows={5} />}>
      <AgentsPageContent searchParams={searchParams} />
    </Suspense>
  );
}
