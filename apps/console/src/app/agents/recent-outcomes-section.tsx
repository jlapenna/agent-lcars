import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import { Card, Stack, Text, Title } from '@mantine/core';

import type { AgentPipeline, AgentRun } from '../../lib/agent-activity';
import { FinishedRunRow } from '../agent-activity-panel';
import { Eyebrow } from '../eyebrow';
import { lcarsPanelStyle } from '../lcars';

const PIPELINES: AgentPipeline[] = ['claude', 'codex', 'opencode'];

const PIPELINE_TITLES: Record<AgentPipeline, string> = {
  claude: 'claude',
  codex: 'codex',
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
  sessionsByRunId = {},
}: {
  recentRuns: AgentRun[];
  /** Joined `issue-agent` session docs, keyed by `AgentRun.id` - see
   * `indexSessionsByNumericRunId` in run-classification.ts. */
  sessionsByRunId?: Record<number, IssueAgentSessionDoc>;
}) {
  return (
    <Card
      withBorder
      radius="md"
      padding="md"
      data-testid="recent-outcomes"
      className="lcars-panel"
      style={lcarsPanelStyle('periwinkle')}
    >
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
              <Eyebrow>
                {PIPELINE_TITLES[pipeline]} ({runs.length})
              </Eyebrow>
              <Stack gap={6}>
                {runs.map((run) => (
                  <FinishedRunRow
                    key={run.id}
                    run={run}
                    session={sessionsByRunId[run.id]}
                  />
                ))}
              </Stack>
            </Stack>
          );
        })}
      </Stack>
    </Card>
  );
}
