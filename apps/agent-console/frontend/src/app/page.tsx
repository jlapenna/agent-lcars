import { Container, Group, Stack, Text, Title } from '@mantine/core';
import { assertAdmin } from '@repo/auth/server';

import { auth } from '../auth';
import {
  type ActionItem,
  isDeployWaitOnly,
  isHandedBack,
} from '../lib/action-items';
import {
  type AgentRun,
  getAgentActivity,
  RUN_TIMEOUT_MINUTES,
} from '../lib/agent-activity';
import { getCliSessions } from '../lib/cli-sessions';
import { derivePrimaryAction } from '../lib/primary-action';
import { type LiveRunSummary } from './action-item-card';
import { ActionItemsBoard, type BoardCard } from './action-items-board';
import { getActionItems } from './actions';
import { AgentActivityPanel, type RunItemRef } from './agent-activity-panel';
import { EvictNxCacheButton } from './evict-nx-cache-button';
import { formatDuration, formatRelativeTime } from './format';
import { QuickTaskButton } from './quick-task-button';
import { RefreshButton } from './refresh-button';
import { ThemeToggle } from './theme-toggle';
import { UnstickPrsButton } from './unstick-prs-button';

export const dynamic = 'force-dynamic';

// The card is a client component, so it gets a preformatted summary instead
// of the raw AgentRun (whose module pulls in the server-only GitHub client).
function toLiveRunSummary(
  run: AgentRun | undefined,
): LiveRunSummary | undefined {
  if (!run) return undefined;
  return {
    id: run.id,
    status: run.status === 'running' ? 'running' : 'queued',
    label:
      run.status === 'running'
        ? `${formatDuration(run.elapsedSeconds)} of ${RUN_TIMEOUT_MINUTES}m budget`
        : `queued for ${formatDuration(run.elapsedSeconds)}`,
    url: run.url,
  };
}

function toCard(item: ActionItem, liveRun?: LiveRunSummary): BoardCard {
  return {
    item,
    updatedAtLabel: formatRelativeTime(item.updatedAt),
    primaryAction: derivePrimaryAction(item),
    liveRun,
  };
}

export default async function Index() {
  const session = await auth();
  assertAdmin(session, '/login');

  const [
    { items, warnings: itemWarnings },
    activity,
    { sessions: cliSessions, warnings: cliSessionWarnings },
  ] = await Promise.all([
    getActionItems(),
    getAgentActivity(),
    getCliSessions(),
  ]);
  // Deduped: parallel fetchers can degrade the same way (e.g. one rate-limit
  // hit per PR-join), and each unique problem only needs saying once.
  const warnings = Array.from(
    new Set([...itemWarnings, ...activity.warnings, ...cliSessionWarnings]),
  );

  // Join live agent runs to items, preferring the run-name-derived issue
  // number (see claude.yml) - it's immune to title edits and duplicate
  // titles. Runs that predate that rollout (issueNumber undefined) fall
  // back to the old title-string match. An item with a live run is the
  // AGENT's to act on, whatever its labels say - it must never be presented
  // as waiting on the maintainer.
  const liveRunByNumber = new Map(
    activity.liveRuns
      .filter((run) => run.issueNumber !== undefined)
      .map((run) => [run.issueNumber as number, run]),
  );
  const liveRunByTitle = new Map(
    activity.liveRuns
      .filter((run) => run.issueNumber === undefined)
      .map((run) => [run.displayTitle, run]),
  );
  const liveRunFor = (item: ActionItem) =>
    liveRunByNumber.get(item.number) ?? liveRunByTitle.get(item.title);

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

  return (
    <Container size="md" py="xl">
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb="xl">
        <div>
          <Title order={1}>Agent Console</Title>
          <Text c="dimmed" mt={4}>
            supersprinklesracing/members &mdash; Claude issue agent activity
          </Text>
        </div>
        <Group gap="sm" wrap="nowrap">
          <QuickTaskButton />
          <UnstickPrsButton />
          <EvictNxCacheButton />
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

      <AgentActivityPanel
        activity={activity}
        cliSessions={cliSessions}
        itemsByRunId={itemsByRunId}
      />

      <ActionItemsBoard
        yourQueue={yourQueue.map((item) => toCard(item))}
        handedBack={handedBack.map((item) => toCard(item))}
        waitingOnDeploy={waitingOnDeploy.map((item) => toCard(item))}
        rest={rest.map((item) => toCard(item))}
      />
    </Container>
  );
}
