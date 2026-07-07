import { Container, Group, Stack, Text, Title } from '@mantine/core';
import { redirect } from 'next/navigation';

import { auth } from '../auth';
import { type ActionItem, isDeployWaitOnly } from '../lib/action-items';
import {
  type AgentRun,
  getAgentActivity,
  RUN_TIMEOUT_MINUTES,
} from '../lib/agent-activity';
import { ActionItemCard, type LiveRunSummary } from './action-item-card';
import { getActionItems } from './actions';
import { AgentActivityPanel } from './agent-activity-panel';
import { formatDuration, formatRelativeTime } from './format';
import { RefreshButton } from './refresh-button';

export const dynamic = 'force-dynamic';

// The card is a client component, so it gets a preformatted summary instead
// of the raw AgentRun (whose module pulls in the server-only GitHub client).
function toLiveRunSummary(
  run: AgentRun | undefined,
): LiveRunSummary | undefined {
  if (!run) return undefined;
  return {
    status: run.status === 'running' ? 'running' : 'queued',
    label:
      run.status === 'running'
        ? `${formatDuration(run.elapsedSeconds)} of ${RUN_TIMEOUT_MINUTES}m budget`
        : `queued for ${formatDuration(run.elapsedSeconds)}`,
    url: run.url,
  };
}

export default async function Index() {
  const session = await auth();
  if (!session?.user?.isAdmin) {
    redirect('/login');
  }

  const [items, activity] = await Promise.all([
    getActionItems(),
    getAgentActivity(),
  ]);

  // Join live agent runs to items: for `issues`/`issue_comment`-triggered
  // runs the workflow run's display title IS the issue/PR title. An item
  // with a live run is the AGENT's to act on, whatever its labels say - it
  // must never be presented as waiting on the maintainer.
  const liveRunByTitle = new Map(
    activity.liveRuns.map((run) => [run.displayTitle, run]),
  );
  const liveRunFor = (item: ActionItem) => liveRunByTitle.get(item.title);

  const agentWorking = items.filter((item) => liveRunFor(item));
  const idle = items.filter((item) => !liveRunFor(item));
  const needsAction = idle.filter(
    (item) => item.actionTypes.length > 0 && !isDeployWaitOnly(item),
  );
  const waitingOnDeploy = idle.filter((item) => isDeployWaitOnly(item));
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
        <RefreshButton
          generatedAt={generatedAt}
          initialLabel={formatRelativeTime(generatedAt)}
        />
      </Group>

      <AgentActivityPanel activity={activity} />

      <Title order={2} mb="sm">
        Needs Your Action ({needsAction.length})
      </Title>
      {needsAction.length === 0 && (
        <Text c="dimmed" mb="xl">
          Nothing waiting on you right now.
        </Text>
      )}
      <Stack gap="sm" mb="xl">
        {needsAction.map((item) => (
          <ActionItemCard
            key={`${item.kind}-${item.number}`}
            item={item}
            updatedAtLabel={formatRelativeTime(item.updatedAt)}
          />
        ))}
      </Stack>

      {agentWorking.length > 0 && (
        <>
          <Title order={2} mb={4}>
            Agent Working ({agentWorking.length})
          </Title>
          <Text c="dimmed" size="sm" mb="sm">
            The agent has the ball — nothing for you here yet.
          </Text>
          <Stack gap="sm" mb="xl">
            {agentWorking.map((item) => (
              <ActionItemCard
                key={`${item.kind}-${item.number}`}
                item={item}
                updatedAtLabel={formatRelativeTime(item.updatedAt)}
                liveRun={toLiveRunSummary(liveRunFor(item))}
              />
            ))}
          </Stack>
        </>
      )}

      {waitingOnDeploy.length > 0 && (
        <>
          <Title order={2} mb={4}>
            Waiting on Next Deploy ({waitingOnDeploy.length})
          </Title>
          <Text c="dimmed" size="sm" mb="sm">
            Verified and closed automatically by the post-deploy agent after the
            next deploy of the affected app.
          </Text>
          <Stack gap="sm" mb="xl">
            {waitingOnDeploy.map((item) => (
              <ActionItemCard
                key={`${item.kind}-${item.number}`}
                item={item}
                updatedAtLabel={formatRelativeTime(item.updatedAt)}
              />
            ))}
          </Stack>
        </>
      )}

      {rest.length > 0 && (
        <>
          <Title order={2} mb="sm">
            Everything Else ({rest.length})
          </Title>
          <Stack gap="sm">
            {rest.map((item) => (
              <ActionItemCard
                key={`${item.kind}-${item.number}`}
                item={item}
                updatedAtLabel={formatRelativeTime(item.updatedAt)}
              />
            ))}
          </Stack>
        </>
      )}
    </Container>
  );
}
