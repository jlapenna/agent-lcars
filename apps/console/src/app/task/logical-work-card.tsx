import type { Run as OrchestratorRun } from '@agent-lcars/orchestrator';
import type { WorkSpec } from '@agent-lcars/work';
import {
  Alert,
  Anchor,
  Badge,
  Card,
  Group,
  Stack,
  Text,
  Title,
} from '@mantine/core';

import type { LogicalWork, LogicalWorkState } from '../../lib/logical-work';
import { PipelineBadge, RepoBadge } from '../agent-activity-panel';
import { lcarsPanelStyle } from '../lcars';
import { RunsSection } from './runs-section';

const STATE_LABELS: Record<LogicalWorkState, string> = {
  unavailable: 'Unavailable',
  dispatching: 'dispatching',
  active: 'active',
  'human-needed': 'needs human',
  completed: 'completed',
  anomaly: 'anomaly',
  unknown: 'unknown',
};

const STATE_COLORS: Record<LogicalWorkState, string> = {
  unavailable: 'gray',
  dispatching: 'blue',
  active: 'blue',
  'human-needed': 'orange',
  completed: 'green',
  anomaly: 'red',
  unknown: 'gray',
};

/** The canonical task view: GitHub anchor metadata plus the task's native
 * control-plane Run history. */
export function LogicalWorkCard({
  work,
  runs,
  anchorState,
  spec,
}: {
  work: LogicalWork;
  runs: OrchestratorRun[];
  anchorState: 'open' | 'closed';
  spec?: WorkSpec;
}) {
  return (
    <Card
      withBorder
      radius="md"
      padding="md"
      className="lcars-panel"
      style={lcarsPanelStyle('amber')}
      data-testid="logical-work-card"
    >
      <Stack gap="sm">
        {spec !== undefined && (
          <div data-testid="work-spec-snapshot" className="work-spec-snapshot">
            <Text size="xs" c="dimmed">
              Dispatch brief snapshot
            </Text>
            <Text size="sm" fw={600}>
              {spec.title}
            </Text>
            <Text size="sm" c="dimmed" lineClamp={3}>
              {spec.description}
            </Text>
          </div>
        )}
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Stack gap={4}>
            <Title order={2} size="h4">
              <Anchor
                href={work.url}
                target="_blank"
                rel="noreferrer"
                c="inherit"
              >
                {'workId' in work.task
                  ? work.title
                  : `#${work.task.issueNumber} ${work.title}`}
              </Anchor>
            </Title>
            <Group gap="xs" wrap="wrap">
              <Badge
                variant="filled"
                color={STATE_COLORS[work.state]}
                size="sm"
                data-testid="logical-work-state"
              >
                {STATE_LABELS[work.state]}
              </Badge>
              <Badge variant="outline" color="gray" size="sm">
                {anchorState}
              </Badge>
              {work.selectedPipeline && (
                <PipelineBadge pipeline={work.selectedPipeline} />
              )}
              <RepoBadge repo={work.task.repository} />
            </Group>
          </Stack>
          <Text size="xs" c="dimmed">
            {work.provenance.kind === 'authoritative'
              ? `authoritative state rev ${work.provenance.revision ?? 'unknown'}`
              : work.provenance.kind === 'unavailable'
                ? 'authoritative lifecycle state unavailable'
                : 'no authoritative run history'}
          </Text>
        </Group>

        {work.anomalies.length > 0 && (
          <Stack gap={6} data-testid="logical-work-anomalies">
            {work.anomalies.map((anomaly, index) => (
              <Alert key={index} color="red" variant="light">
                {anomaly.detail}
              </Alert>
            ))}
          </Stack>
        )}

        {runs.length > 0 ? (
          <RunsSection runs={runs} />
        ) : (
          <Text size="sm" c="dimmed" data-testid="no-authoritative-runs">
            No authoritative runs recorded for this task.
          </Text>
        )}
      </Stack>
    </Card>
  );
}
