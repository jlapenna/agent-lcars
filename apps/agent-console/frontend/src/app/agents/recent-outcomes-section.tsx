import { Card, Stack, Text, Title } from '@mantine/core';

import type { AgentPipeline, AgentRun } from '../../lib/agent-activity';
import { FinishedRunRow } from '../agent-activity-panel';

const PIPELINES: AgentPipeline[] = ['claude', 'opencode'];

const PIPELINE_TITLES: Record<AgentPipeline, string> = {
  claude: 'claude',
  opencode: 'opencode',
};

/**
 * Recent conclusions grouped per pipeline - the same merged recent-runs
 * list the home page collapses behind "Recently finished", just always
 * visible here and split by pipeline: this page cares about the fleet's
 * per-pipeline outcomes, not a single maintainer queue.
 */
export function RecentOutcomesSection({
  recentRuns,
}: {
  recentRuns: AgentRun[];
}) {
  return (
    <Card withBorder radius="md" padding="md" data-testid="recent-outcomes">
      <Stack gap="sm">
        <Title order={2} size="h4">
          Recent Outcomes
        </Title>
        {recentRuns.length === 0 && (
          <Text size="sm" c="dimmed">
            No recently finished runs.
          </Text>
        )}
        {PIPELINES.map((pipeline) => {
          const runs = recentRuns.filter((run) => run.pipeline === pipeline);
          if (runs.length === 0) return null;
          return (
            <Stack key={pipeline} gap={6}>
              <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                {PIPELINE_TITLES[pipeline]} ({runs.length})
              </Text>
              <Stack gap={6}>
                {runs.map((run) => (
                  <FinishedRunRow key={run.id} run={run} />
                ))}
              </Stack>
            </Stack>
          );
        })}
      </Stack>
    </Card>
  );
}
