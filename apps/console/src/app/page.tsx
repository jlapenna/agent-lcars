import { Anchor, Container } from '@mantine/core';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../auth';
import {
  type ActionItem,
  isDeployWaitOnly,
  isHandedBack,
} from '../lib/action-items';
import { getAgentActivity } from '../lib/agent-activity';
import { getCliSessions } from '../lib/cli-sessions';
import {
  getWatchedRepos,
  parseRepoFilterParam,
  primaryWatchedRepo,
  repoItemKey,
  repoKey,
} from '../lib/github-client';
import { derivePrimaryAction } from '../lib/primary-action';
import {
  deriveSilentErrorDiagnoses,
  indexSessionsByNumericRunId,
} from '../lib/run-classification';
import { getRunnerSessionsByRunId } from '../lib/runner-sessions';
import { ActionItemsBoard, type BoardCard } from './action-items-board';
import { getActionItems } from './actions';
import { AgentActivityPanel, type RunItemRef } from './agent-activity-panel';
import { ConsoleHeader } from './console-header';
import { EvictNxCacheButton } from './evict-nx-cache-button';
import { formatCompactRelativeTime, formatRelativeTime } from './format';
import { QuickTaskButton } from './quick-task-button';
import { UnstickPrsButton } from './unstick-prs-button';

export const dynamic = 'force-dynamic';

function toCard(item: ActionItem): BoardCard {
  return {
    item,
    updatedAtLabel: formatCompactRelativeTime(item.updatedAt),
    primaryAction: derivePrimaryAction(item),
  };
}

interface PageProps {
  searchParams: Promise<{ repo?: string }>;
}

export default async function Index({ searchParams }: PageProps) {
  const session = await auth();
  assertAdmin(session, '/login');

  const watchedRepos = getWatchedRepos();
  const repoFilter = parseRepoFilterParam((await searchParams).repo);

  const [
    { items: rawItems, warnings: itemWarnings },
    activity,
    { sessions: cliSessions, warnings: cliSessionWarnings },
    { sessionsByRunId: runnerSessionsByRunId, warnings: runnerSessionWarnings },
  ] = await Promise.all([
    getActionItems(),
    getAgentActivity(),
    getCliSessions(),
    getRunnerSessionsByRunId(),
  ]);
  // Deduped: parallel fetchers can degrade the same way (e.g. one rate-limit
  // hit per PR-join), and each unique problem only needs saying once.
  const warnings = Array.from(
    new Set([
      ...itemWarnings,
      ...activity.warnings,
      ...cliSessionWarnings,
      ...runnerSessionWarnings,
    ]),
  );

  // run.id -> joined session doc, for every run this page renders (live and
  // recent alike) - powers the In Flight budget gauges and the Recent
  // Outcomes classification/diagnosis (see agent-activity-panel.tsx).
  const sessionsByRunId = indexSessionsByNumericRunId(
    [...activity.liveRuns, ...activity.recentRuns],
    runnerSessionsByRunId,
  );

  // Elevate finished runs the classifier flagged `silent-error` (GitHub said
  // success, but the session shows a known failure signature or recorded
  // essentially no work) into "Needs Your Action", even though nothing in
  // the item's own GitHub state says anything is wrong.
  const silentErrorByIssue = deriveSilentErrorDiagnoses(
    activity.recentRuns,
    runnerSessionsByRunId,
  );
  const items: ActionItem[] = rawItems.map((item) => {
    const diagnosis = silentErrorByIssue.get(
      repoItemKey(item.repo, item.number),
    );
    if (!diagnosis) return item;
    return {
      ...item,
      actionTypes: [...item.actionTypes, 'silent-error'],
      silentErrorDiagnosis: diagnosis,
    };
  });

  // Join live agent runs to items by the run-name-derived issue number (see
  // claude.yml and opencode.yml - issueNumberFromDisplayTitle accepts both
  // run-name formats) - immune to title edits and duplicate titles, and
  // pipeline-agnostic by construction. The old exact-title fallback for
  // runs predating the run-name rollout is gone (#3023): every live run
  // has carried a parseable run-name for months, and matching on a
  // human-editable title string was the fragile path. An item with a live
  // run is the AGENT's to act on, whatever its labels say - it must never
  // be presented as waiting on the maintainer.
  const liveRunByNumber = new Map(
    activity.liveRuns
      .filter((run) => run.issueNumber !== undefined)
      .map((run) => [repoItemKey(run.repo, run.issueNumber as number), run]),
  );
  const liveRunFor = (item: ActionItem) =>
    liveRunByNumber.get(repoItemKey(item.repo, item.number));

  // The reverse join: live runs annotated with the item they're working, so
  // the In Flight panel can link the issue instead of the raw run title.
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

  // Bucketing by whose move it is:
  // - an item with a live run is the agent's (shown in In Flight);
  // - human-needed answered by the maintainer is the agent's (Handed Back);
  // - post-deploy-only waits on the deploy pipeline;
  // - actionable leftovers are the maintainer's queue;
  // - everything else is inventory, collapsed at the bottom.
  const idle = items.filter((item) => !liveRunFor(item));
  const handedBack = idle.filter(isHandedBack);
  const yourQueue = idle.filter(
    (item) =>
      item.actionTypes.length > 0 &&
      !isDeployWaitOnly(item) &&
      !isHandedBack(item),
  );
  const waitingOnDeploy = idle.filter(
    (item) => isDeployWaitOnly(item) && !isHandedBack(item),
  );
  const rest = idle.filter((item) => item.actionTypes.length === 0);
  const generatedAt = new Date().toISOString();

  // Applied last, after every cross-repo join above (itemsByRunId,
  // liveRunFor, silent-error diagnoses) already ran against the full,
  // unfiltered data - a repo filter should narrow what's *displayed*, never
  // which items can see each other's runs/sessions. No filter chrome beyond
  // the `?repo=` param itself (matching parseSessionArchiveQuery's "a
  // maintainer edits the URL bar directly" philosophy, #2694/#3019) - the
  // repo badges throughout the board link here.
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
  // A doc with no `repo` predates Phase 0's field - session-archive.ts and
  // cli-sessions.ts both already treat that as belonging to the primary
  // repo when building links, so the filter must agree: otherwise every
  // legacy session stays visible under every repo filter instead of just
  // the primary one.
  const filteredCliSessions = repoFilter
    ? cliSessions.filter((s) => matchesFilter(s.repo ?? primaryWatchedRepo()))
    : cliSessions;

  const subtitle =
    watchedRepos.length <= 1
      ? `${repoKey(watchedRepos[0])} — Claude + OpenCode agent activity`
      : repoFilter
        ? `${repoKey(repoFilter)} — Claude + OpenCode agent activity`
        : `${watchedRepos.length} repos — Claude + OpenCode agent activity`;

  return (
    <Container size="md" py="xl">
      <ConsoleHeader
        current="queue"
        title="Agent LCARS"
        subtitle={
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
        }
        actions={
          <>
            <QuickTaskButton watchedRepos={watchedRepos} />
            <UnstickPrsButton />
            <EvictNxCacheButton />
          </>
        }
        generatedAt={generatedAt}
        refreshLabel={formatRelativeTime(generatedAt)}
        warnings={warnings}
      />

      <ActionItemsBoard
        yourQueue={yourQueue
          .filter((i) => matchesFilter(i.repo))
          .map((item) => toCard(item))}
        handedBack={handedBack
          .filter((i) => matchesFilter(i.repo))
          .map((item) => toCard(item))}
        waitingOnDeploy={waitingOnDeploy
          .filter((i) => matchesFilter(i.repo))
          .map((item) => toCard(item))}
        rest={rest
          .filter((i) => matchesFilter(i.repo))
          .map((item) => toCard(item))}
      />

      <AgentActivityPanel
        activity={filteredActivity}
        cliSessions={filteredCliSessions}
        itemsByRunId={itemsByRunId}
        sessionsByRunId={sessionsByRunId}
      />
    </Container>
  );
}
