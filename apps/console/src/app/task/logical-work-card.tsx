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

import { issueUrlForRun } from '../../lib/agent-activity';
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

/** `unattributed` attempts never reach this card - `deriveLogicalWork`
 * diverts them into its separate `unattributedAttempts` bucket - so the
 * label map covers only the attributions a task's own attempts can carry. */
const ATTRIBUTION_LABELS: Record<
  Exclude<AttemptAttribution, 'unattributed'>,
  string
> = {
  orchestrator: 'orchestrator',
  'run-marker': 'run marker',
  'legacy-title': 'legacy title',
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
 * orchestrator's own run history
 * (when any exists), and every legacy execution attempt with nothing
 * collapsed away. Anomalies render as visible alerts, never a
 * silently-chosen representative row - this is the "operators can explain
 * why every visible run exists" surface the /task/<owner>/<repo>/<issue>
 * route (task-detail.ts's `getTaskDetail`) exists to provide - which is also
 * why the native Runs section (#1015) is additive rather than a replacement:
 * it never hides a real GitHub Actions attempt the legacy list would
 * otherwise have shown (see this component's own attempts-block comment).
 */
export function LogicalWorkCard({
  work,
  runs,
  anchorState,
  spec,
}: {
  work: LogicalWork;
  /** This task's own `@agent-lcars/orchestrator` run history (#1015),
   * verbatim from `task-detail.ts`'s `getTaskDetail`. Renders as a native
   * `RunsSection` above the legacy "Execution attempts" list whenever
   * non-empty; an empty array (pre-cutover history, or a repo the
   * orchestrator never covers) leaves the page exactly as it rendered
   * before #1015. */
  runs: OrchestratorRun[];
  anchorState: 'open' | 'closed';
  /** The dispatch brief's `work.spec` snapshot, when this task carries one
   *  (sub-project 5) -- what the agent's brief actually saw, which may
   *  differ from the issue's current live title/body if it was edited
   *  after the first dispatch. */
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
            {work.provenance.kind === 'authoritative-v1'
              ? `authoritative state rev ${work.provenance.revision}`
              : work.provenance.kind === 'unavailable'
                ? 'authoritative lifecycle state unavailable'
                : 'no authoritative lifecycle state'}
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

        {runs.length > 0 && <RunsSection runs={runs} />}

        {/* The legacy attempts list stays visible whenever it has real
         * content (#1015): a GitHub Actions attempt carries live-CI facts
         * (its own URL, elapsed time, queued-vs-running) `RunsSection`
         * above cannot show, and today's `intentId`/`runId` attribution join
         * does not yet reliably fold every attempt into the orchestrator's
         * own run history (see task-detail.ts's `attributeAttemptsToOrchestrator`
         * doc comment) - so this never disappears out from under a real,
         * currently-visible attempt, anomaly included. Only its empty-state
         * placeholder retires once real run history exists: "no workflow
         * runs attributed" reads as wrong sitting directly under a populated
         * Runs section. */}
        {(work.attempts.length > 0 || runs.length === 0) && (
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
                    {
                      ATTRIBUTION_LABELS[
                        // See ATTRIBUTION_LABELS: unattributed attempts are
                        // structurally kept out of task cards.
                        attempt.attribution as Exclude<
                          AttemptAttribution,
                          'unattributed'
                        >
                      ]
                    }
                  </Badge>
                  <Anchor
                    href={issueUrlForRun(attempt) ?? attempt.url}
                    target="_blank"
                    rel="noreferrer"
                    size="xs"
                    truncate
                  >
                    {attempt.displayTitle}
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
        )}
      </Stack>
    </Card>
  );
}
