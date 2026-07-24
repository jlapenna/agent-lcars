import { Badge, Card, Group, Stack, Text } from '@mantine/core';

import type { AgentActivity, AgentPipeline } from '../../lib/agent-activity';
import {
  FleetChip,
  PipelineBadge,
  QueueHealthAlert,
} from '../agent-activity-panel';
import { lcarsPanelStyle } from '../lcars';

const PIPELINES: AgentPipeline[] = ['claude', 'codex', 'opencode'];

/**
 * The top strip of the /agents page: "what's the fleet doing right now" at
 * a glance - live run counts per pipeline, active CLI session count, runner
 * fleet size, and the same queue-stall alert the home page's In Flight
 * panel shows (reused verbatim via QueueHealthAlert - it's the same
 * underlying signal, just surfaced a second place for the agent-focused
 * view).
 */
export function FleetSnapshotBar({
  activity,
  activeCliSessionCount,
}: {
  activity: AgentActivity;
  activeCliSessionCount: number;
}) {
  const { liveRuns, fleet, fleetByRepo } = activity;
  const liveCountByPipeline = (pipeline: AgentPipeline) =>
    liveRuns.filter((run) => run.pipeline === pipeline).length;

  return (
    <Card
      withBorder
      radius="md"
      padding="md"
      mb="xl"
      data-testid="fleet-snapshot-bar"
      className="lcars-panel"
      style={lcarsPanelStyle('periwinkle')}
    >
      <Stack gap="sm">
        <Group gap="lg" wrap="wrap">
          {PIPELINES.map((pipeline) => (
            <Group key={pipeline} gap={6} wrap="nowrap">
              <PipelineBadge pipeline={pipeline} />
              <Text size="sm">{liveCountByPipeline(pipeline)} live</Text>
            </Group>
          ))}
          <Group gap={6} wrap="nowrap">
            <Badge
              variant="outline"
              color="teal"
              size="xs"
              style={{ flexShrink: 0 }}
            >
              CLI
            </Badge>
            <Text size="sm">{activeCliSessionCount} active</Text>
          </Group>
          <FleetChip fleet={fleet} />
        </Group>
        {fleetByRepo && (
          <Group gap="md" wrap="wrap" data-testid="fleet-by-repo">
            {Object.entries(fleetByRepo).map(([repo, repoFleet]) => (
              <Text key={repo} size="xs" c="dimmed">
                {repo}: {repoFleet.online} runner
                {repoFleet.online === 1 ? '' : 's'}
                {repoFleet.busy > 0 ? ` (${repoFleet.busy} busy)` : ''}
              </Text>
            ))}
          </Group>
        )}
        <QueueHealthAlert liveRuns={liveRuns} />
      </Stack>
    </Card>
  );
}
