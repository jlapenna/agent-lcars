import { Badge, Card, Group, Stack, Text } from '@mantine/core';

import type { AgentActivity, AgentPipeline } from '../../lib/agent-activity';
import type { ActivityMetrics } from '../../lib/logical-work';
import {
  FleetChip,
  PipelineBadge,
  QueueHealthAlert,
} from '../agent-activity-panel';
import { lcarsPanelStyle } from '../lcars';

const PIPELINES: AgentPipeline[] = ['claude', 'codex', 'opencode'];

/**
 * #306's capacity-vs-work distinction, spelled out: three numbers that each
 * answer a different question and must never be read as substitutes for one
 * another (see `deriveActivityMetrics`'s own doc comment). Optional so
 * every existing caller/test that doesn't yet compute `LogicalWork` keeps
 * rendering exactly as before - this is additive chrome, not a replacement
 * for the per-pipeline live counts above it.
 */
function MetricsRow({ metrics }: { metrics: ActivityMetrics }) {
  const hasDispatchWork =
    metrics.logicalTaskCount > 0 ||
    metrics.queuedAttempts > 0 ||
    metrics.runningAttempts > 0;

  if (!hasDispatchWork) {
    return (
      <Text size="xs" c="dimmed" data-testid="activity-metrics-row">
        No queued or running dispatches
      </Text>
    );
  }

  return (
    <Group gap="md" wrap="wrap" data-testid="activity-metrics-row">
      <Text size="xs" c="dimmed" data-testid="metric-logical-tasks">
        {metrics.logicalTaskCount} logical task
        {metrics.logicalTaskCount === 1 ? '' : 's'}
      </Text>
      <Text size="xs" c="dimmed" data-testid="metric-queued-attempts">
        {metrics.queuedAttempts} queued attempt
        {metrics.queuedAttempts === 1 ? '' : 's'}
      </Text>
      <Text size="xs" c="dimmed" data-testid="metric-running-attempts">
        {metrics.runningAttempts} running attempt
        {metrics.runningAttempts === 1 ? '' : 's'}
      </Text>
      {metrics.onlineRunners !== undefined && (
        <Text size="xs" c="dimmed" data-testid="metric-runner-occupancy">
          {metrics.busyRunners ?? 0}/{metrics.onlineRunners} runners busy
        </Text>
      )}
    </Group>
  );
}

/**
 * The top strip of the /agents page: "what's the fleet doing right now" at
 * a glance - live run counts per pipeline, active CLI session count, runner
 * fleet size, and the same queue-stall alert the home page's In Flight
 * panel shows (reused verbatim via QueueHealthAlert - it's the same
 * underlying signal, just surfaced a second place for the agent-focused
 * view). `metrics` (#306) adds the logical-task/attempt/runner-occupancy
 * distinction as its own row, deliberately separate from the per-pipeline
 * "N live" counts above (which count raw attempts, not logical tasks - see
 * #306's own duplicate-attempt handling in agent-activity-panel.tsx).
 */
export function FleetSnapshotBar({
  activity,
  activeCliSessionCount,
  metrics,
}: {
  activity: AgentActivity;
  activeCliSessionCount: number;
  metrics?: ActivityMetrics;
}) {
  const { liveRuns, fleet, fleetByRepo } = activity;
  const liveCountByPipeline = (pipeline: AgentPipeline) =>
    liveRuns.filter((run) => run.pipeline === pipeline).length;
  const activePipelines = PIPELINES.filter(
    (pipeline) => liveCountByPipeline(pipeline) > 0,
  );

  return (
    <Card
      withBorder
      radius="md"
      padding="md"
      mb="xl"
      data-testid="fleet-snapshot-bar"
      className="lcars-panel agents-fleet-strip"
      style={lcarsPanelStyle('periwinkle')}
    >
      <Stack gap="sm">
        <Group gap="lg" wrap="wrap">
          {activePipelines.length > 0 ? (
            activePipelines.map((pipeline) => (
              <Group key={pipeline} gap={6} wrap="nowrap">
                <PipelineBadge pipeline={pipeline} />
                <Text size="sm">{liveCountByPipeline(pipeline)} live</Text>
              </Group>
            ))
          ) : (
            <Text size="sm" c="dimmed">
              No workflow runs active
            </Text>
          )}
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
        {metrics && <MetricsRow metrics={metrics} />}
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
