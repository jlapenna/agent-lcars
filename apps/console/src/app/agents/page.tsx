import { Anchor, Container, Group, Stack, Text, Title } from '@mantine/core';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../auth';
import { type ActionItem } from '../../lib/action-items';
import { getAgentActivity } from '../../lib/agent-activity';
import { deriveClaimedIdle } from '../../lib/claimed-idle';
import { getCliSessions } from '../../lib/cli-sessions';
import {
  getWatchedRepos,
  parseRepoFilterParam,
  primaryWatchedRepo,
  repoItemKey,
  repoKey,
} from '../../lib/github-client';
import { indexSessionsByNumericRunId } from '../../lib/run-classification';
import { getRunnerSessionsByRunId } from '../../lib/runner-sessions';
import { getActionItems } from '../actions';
import type { RunItemRef } from '../agent-activity-panel';
import { formatRelativeTime } from '../format';
import { RefreshButton } from '../refresh-button';
import { ThemeToggle } from '../theme-toggle';
import { ActiveAgentsSection } from './active-agents-section';
import { ClaimedIdleSection } from './claimed-idle-section';
import { FleetSnapshotBar } from './fleet-snapshot-bar';
import { RecentOutcomesSection } from './recent-outcomes-section';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ repo?: string }>;
}

export default async function AgentsPage({ searchParams }: PageProps) {
  const session = await auth();
  assertAdmin(session, '/login');

  const watchedRepos = getWatchedRepos();
  const repoFilter = parseRepoFilterParam((await searchParams).repo);
  const matchesFilter = (repo: { owner: string; name: string }) =>
    !repoFilter || repoKey(repo) === repoKey(repoFilter);

  const [
    { items, warnings: itemWarnings },
    activity,
    { sessions: cliSessions, warnings: cliSessionWarnings },
    { sessionsByRunId: runnerSessionsByRunId, warnings: runnerSessionWarnings },
  ] = await Promise.all([
    getActionItems(),
    getAgentActivity(),
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

  const generatedAt = new Date().toISOString();

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
        ? repoKey(repoFilter)
        : `${watchedRepos.length} repos`;

  return (
    <Container size="md" py="xl">
      <Group justify="space-between" align="flex-start" gap="sm" mb="xl">
        <div>
          <Title order={1}>Agent Status</Title>
          <Text c="dimmed" mt={4}>
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
          </Text>
        </div>
        <Group gap="sm">
          <Anchor href="/" size="sm">
            ← Task queue
          </Anchor>
          <Anchor href="/sessions" size="sm">
            Session archive →
          </Anchor>
          <RefreshButton
            generatedAt={generatedAt}
            initialLabel={formatRelativeTime(generatedAt)}
          />
          <ThemeToggle size="lg" />
        </Group>
      </Group>

      {warnings.length > 0 && (
        <details data-testid="data-warnings" style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer' }}>
            <Text size="sm" c="yellow" component="span">
              ⚠ {warnings.length} data warning
              {warnings.length === 1 ? '' : 's'} — some sections may be
              incomplete
            </Text>
          </summary>
          <Stack gap={4} mt="xs">
            {warnings.map((warning) => (
              <Text key={warning} size="xs" c="dimmed">
                {warning}
              </Text>
            ))}
          </Stack>
        </details>
      )}

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
    </Container>
  );
}
