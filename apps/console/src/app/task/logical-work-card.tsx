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

import { displayRunTitle, issueUrlForRun } from '../../lib/agent-activity';
import type {
  AttemptAttribution,
  ExecutionAttempt,
  LogicalWork,
  LogicalWorkState,
} from '../../lib/logical-work';
import { classifyAgentRun } from '../../lib/run-classification';
import {
  DispatchOutcomeBadge,
  PipelineBadge,
  RepoBadge,
  STATUS_COLORS,
  STATUS_LABELS,
} from '../agent-activity-panel';
import { formatDuration } from '../format';
import { lcarsPanelStyle } from '../lcars';
import { PersistedDetails } from '../persisted-details';
import { RelativeTime } from '../relative-time';

const STATE_LABELS: Record<LogicalWorkState, string> = {
  pending: 'pending',
  dispatching: 'dispatching',
  active: 'active',
  'human-needed': 'needs human',
  completed: 'completed',
  anomaly: 'anomaly',
  unknown: 'unknown',
};

const STATE_COLORS: Record<LogicalWorkState, string> = {
  pending: 'gray',
  dispatching: 'blue',
  active: 'blue',
  'human-needed': 'orange',
  completed: 'green',
  anomaly: 'red',
  unknown: 'gray',
};

const ATTRIBUTION_LABELS: Record<AttemptAttribution, string> = {
  ledger: 'ledger',
  'run-marker': 'run marker',
  'legacy-title': 'legacy title',
  unattributed: 'unattributed',
};

/**
 * `classifyAgentRun`/`classifyRunStatus` treats every non-completed run
 * status as `running` - it only exists to distinguish a *finished* run's
 * outcome (see run-status-classifier.ts's own doc comment), and has no
 * notion of "queued" at all. That's fine once an attempt is actually
 * running, but running a queued attempt through it would relabel "queued"
 * as "running" - claiming work is actively executing when it may still be
 * waiting for a runner (Codex review on #375). Handle queued explicitly
 * with the same gray "queued" badge agent-activity-panel.tsx's `LiveRunRow`
 * already uses for a live run's own queued state, and only run the
 * classifier for running/completed attempts - where its "running" mapping
 * is already correct and its completed-outcome classification is exactly
 * what this badge exists to show.
 */
function attemptStatusBadge(attempt: ExecutionAttempt): {
  label: string;
  color: string;
} {
  if (attempt.status === 'queued') {
    return { label: 'queued', color: 'gray' };
  }
  const classification = classifyAgentRun(attempt);
  return {
    label: STATUS_LABELS[classification.status],
    color: STATUS_COLORS[classification.status],
  };
}

/**
 * The canonical logical-task card (#306): task identity, current state, the
 * intent (ledger generation) history, and every execution attempt with
 * nothing collapsed away. Anomalies render as visible alerts, never a
 * silently-chosen representative row - this is the "operators can explain
 * why every visible run exists" surface the /task/<owner>/<repo>/<issue>
 * route (task-detail.ts's `getTaskDetail`) exists to provide.
 */
export function LogicalWorkCard({
  work,
  anchorState,
}: {
  work: LogicalWork;
  anchorState: 'open' | 'closed';
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
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Stack gap={4}>
            <Title order={2} size="h4">
              <Anchor
                href={work.url}
                target="_blank"
                rel="noreferrer"
                c="inherit"
              >
                #{work.task.issueNumber} {work.title}
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
            {work.provenance.kind === 'ledger-v1'
              ? `dispatch ledger rev ${work.provenance.revision}`
              : 'no dispatch ledger (legacy attribution only)'}
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

        {work.intents.length > 0 && (
          <PersistedDetails
            data-testid="logical-work-intents"
            // An anomaly must not stay hidden behind a remembered "closed":
            // omit the storage key and pin open when anomalies exist.
            storageKey={work.anomalies.length > 0 ? undefined : 'task:intents'}
            defaultOpen={work.anomalies.length > 0}
            summary={
              <Text component="span" size="sm" fw={600}>
                Dispatch intents ({work.intents.length})
              </Text>
            }
          >
            <Stack gap={6} mt="xs">
              {work.intents.map((intent) => (
                <Group key={intent.intentId} gap="xs" wrap="wrap">
                  <Badge variant="outline" size="xs" color="gray">
                    g{intent.generation}
                  </Badge>
                  <PipelineBadge pipeline={intent.pipeline} />
                  <Text size="xs">{intent.state}</Text>
                  {intent.outcome && (
                    <DispatchOutcomeBadge outcome={intent.outcome} />
                  )}
                  {intent.sourceKind && (
                    <Text size="xs" c="dimmed">
                      via {intent.sourceKind}
                    </Text>
                  )}
                  <Text size="xs" c="dimmed">
                    <RelativeTime iso={intent.occurredAt} />
                  </Text>
                </Group>
              ))}
            </Stack>
          </PersistedDetails>
        )}

        <Stack gap={6} data-testid="logical-work-attempts">
          <Text size="sm" fw={600}>
            Execution attempts ({work.attempts.length})
          </Text>
          {work.attempts.length === 0 && (
            <Text size="sm" c="dimmed">
              No workflow runs attributed to this task yet.
            </Text>
          )}
          {work.attempts.map((attempt) => {
            const badge = attemptStatusBadge(attempt);
            return (
              <Group
                key={attempt.id}
                gap="xs"
                wrap="wrap"
                data-testid={`logical-work-attempt-${attempt.id}`}
              >
                <Badge variant="filled" color={badge.color} size="xs">
                  {badge.label}
                </Badge>
                <PipelineBadge pipeline={attempt.pipeline} />
                {attempt.outcome && (
                  <DispatchOutcomeBadge outcome={attempt.outcome} />
                )}
                {attempt.generation !== undefined && (
                  <Badge variant="outline" size="xs" color="gray">
                    g{attempt.generation}
                  </Badge>
                )}
                <Badge variant="outline" size="xs" color="gray">
                  {ATTRIBUTION_LABELS[attempt.attribution]}
                </Badge>
                <Anchor
                  href={issueUrlForRun(attempt) ?? attempt.url}
                  target="_blank"
                  rel="noreferrer"
                  size="xs"
                  truncate
                >
                  {displayRunTitle(attempt)}
                </Anchor>
                <Text size="xs" c="dimmed">
                  {formatDuration(attempt.elapsedSeconds)}
                </Text>
                <Anchor
                  href={attempt.url}
                  target="_blank"
                  rel="noreferrer"
                  size="xs"
                  c="dimmed"
                >
                  View run ↗
                </Anchor>
              </Group>
            );
          })}
        </Stack>
      </Stack>
    </Card>
  );
}
