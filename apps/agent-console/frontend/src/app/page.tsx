import { Alert, Container, Group, Stack, Text, Title } from '@mantine/core';
import { assertAdmin } from '@repo/auth/server';

import { auth } from '../auth';
import { type ActionItem, isDeployWaitOnly } from '../lib/action-items';
import {
  type AgentRun,
  getAgentActivity,
  RUN_TIMEOUT_MINUTES,
} from '../lib/agent-activity';
import { type LiveRunSummary } from './action-item-card';
import { ActionItemsBoard, type BoardCard } from './action-items-board';
import { getActionItems } from './actions';
import { AgentActivityPanel } from './agent-activity-panel';
import { formatDuration, formatRelativeTime } from './format';
import { RefreshButton } from './refresh-button';
import { ThemeToggle } from './theme-toggle';

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
    liveRun,
  };
}

export default async function Index() {
  const session = await auth();
  assertAdmin(session, '/login');

  const [{ items, warnings: itemWarnings }, activity] = await Promise.all([
    getActionItems(),
    getAgentActivity(),
  ]);
  const warnings = [...itemWarnings, ...activity.warnings];

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
        <Group gap="sm" wrap="nowrap">
          <RefreshButton
            generatedAt={generatedAt}
            initialLabel={formatRelativeTime(generatedAt)}
          />
          <ThemeToggle size="lg" />
        </Group>
      </Group>

      {warnings.length > 0 && (
        <Alert
          color="yellow"
          variant="light"
          title="Data may be incomplete"
          mb="lg"
        >
          <Stack gap={4}>
            {warnings.map((warning) => (
              <Text key={warning} size="sm">
                {warning}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      <AgentActivityPanel activity={activity} />

      <ActionItemsBoard
        needsAction={needsAction.map((item) => toCard(item))}
        agentWorking={agentWorking.map((item) =>
          toCard(item, toLiveRunSummary(liveRunFor(item))),
        )}
        waitingOnDeploy={waitingOnDeploy.map((item) => toCard(item))}
        rest={rest.map((item) => toCard(item))}
      />
    </Container>
  );
}
