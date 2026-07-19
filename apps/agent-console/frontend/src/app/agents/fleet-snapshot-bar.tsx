import { Badge, Card, Group, Stack, Text } from '@mantine/core';

import type { AgentActivity, AgentPipeline } from '../../lib/agent-activity';
import {
  FleetChip,
  PipelineBadge,
  QueueHealthAlert,
} from '../agent-activity-panel';

const PIPELINES: AgentPipeline[] = ['claude', 'opencode'];

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
  const { liveRuns, fleet } = activity;
  const liveCountByPipeline = (pipeline: AgentPipeline) =>
    liveRuns.filter((run) => run.pipeline === pipeline).length;

  return (
    <Card
      withBorder
      radius="md"
      padding="md"
      mb="xl"
      data-testid="fleet-snapshot-bar"
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
        <QueueHealthAlert liveRuns={liveRuns} />
      </Stack>
    </Card>
  );
}
