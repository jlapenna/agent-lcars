import {
  Alert,
  Anchor,
  Badge,
  Card,
  Group,
  Progress,
  Stack,
  Text,
  Title,
} from '@mantine/core';

import type {
  AgentActivity,
  AgentRun,
  AgentRunConclusion,
  RunnerStatus,
} from '../lib/agent-activity';
import { RUN_TIMEOUT_MINUTES } from '../lib/agent-activity';
import type { CliSession } from '../lib/cli-sessions';
import { CancelRunButton } from './cancel-run-button';
import {
  formatDuration,
  formatRelativeTime,
  formatTokenCount,
} from './format';

const CONCLUSION_LABELS: Record<AgentRunConclusion, string> = {
  success: 'success',
  failure: 'failed',
  cancelled: 'cancelled',
  other: 'other',
};

const CONCLUSION_COLORS: Record<AgentRunConclusion, string> = {
  success: 'green',
  failure: 'red',
  cancelled: 'yellow',
  other: 'gray',
};

// A cancelled run at (or near) the timeout budget almost certainly WAS the
// timeout - claude.yml's kill posts nothing to the issue by itself, so this
// is the place that difference becomes visible.
const LIKELY_TIMEOUT_FRACTION = 0.95;

function isLikelyTimeout(run: AgentRun): boolean {
  return (
    run.conclusion === 'cancelled' &&
    run.elapsedSeconds >= RUN_TIMEOUT_MINUTES * 60 * LIKELY_TIMEOUT_FRACTION
  );
}

function budgetColor(fraction: number): string {
  if (fraction >= 0.8) return 'red';
  if (fraction >= 0.5) return 'yellow';
  return 'blue';
}

function RunnerBadge({ runner }: { runner: RunnerStatus }) {
  const color = !runner.online ? 'red' : runner.busy ? 'orange' : 'green';
  const label = !runner.online ? 'offline' : runner.busy ? 'busy' : 'idle';
  return (
    <Badge variant="light" color={color} size="sm">
      {runner.name}: {label}
    </Badge>
  );
}

function LiveRunRow({ run }: { run: AgentRun }) {
  const budgetFraction = run.elapsedSeconds / (RUN_TIMEOUT_MINUTES * 60);
  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="nowrap">
        <Badge
          variant="filled"
          color={run.status === 'running' ? 'blue' : 'gray'}
          size="sm"
        >
          {run.status === 'running' ? 'running' : 'queued'}
        </Badge>
        <Text size="sm" style={{ minWidth: 0 }}>
          {run.status === 'running'
            ? `${formatDuration(run.elapsedSeconds)} of ${RUN_TIMEOUT_MINUTES}m budget`
            : `waiting for a runner for ${formatDuration(run.elapsedSeconds)}`}
        </Text>
        <Text size="xs" c="dimmed">
          via {run.event}
        </Text>
        <Group
          gap={6}
          wrap="nowrap"
          style={{ marginLeft: 'auto', flexShrink: 0 }}
        >
          <Anchor
            href={run.url}
            target="_blank"
            rel="noreferrer"
            size="xs"
            c="dimmed"
          >
            View run ↗
          </Anchor>
          <CancelRunButton runId={run.id} label={run.displayTitle} />
        </Group>
      </Group>
      {run.status === 'running' && (
        <Progress
          value={Math.min(100, budgetFraction * 100)}
          color={budgetColor(budgetFraction)}
          size="sm"
        />
      )}
    </Stack>
  );
}

function RecentRunRow({ run }: { run: AgentRun }) {
  const conclusion = run.conclusion ?? 'other';
  return (
    <Group gap="xs" wrap="nowrap">
      <Badge variant="light" color={CONCLUSION_COLORS[conclusion]} size="sm">
        {isLikelyTimeout(run) ? 'timeout' : CONCLUSION_LABELS[conclusion]}
      </Badge>
      <Text size="xs" c="dimmed">
        {formatDuration(run.elapsedSeconds)} · finished{' '}
        {formatRelativeTime(run.updatedAt)} · via {run.event}
      </Text>
      <Anchor
        href={run.url}
        target="_blank"
        rel="noreferrer"
        size="xs"
        c="dimmed"
        style={{ marginLeft: 'auto', flexShrink: 0 }}
      >
        View run ↗
      </Anchor>
    </Group>
  );
}

// live/idle are the process still doing something; ended/stale render last.
const LIVENESS_SORT_ORDER: Record<CliSession['liveness'], number> = {
  live: 0,
  idle: 1,
  ended: 2,
  stale: 3,
};

const LIVENESS_LABELS: Record<CliSession['liveness'], string> = {
  live: 'live',
  idle: 'idle',
  ended: 'ended',
  stale: 'stale',
};

const LIVENESS_COLORS: Record<CliSession['liveness'], string> = {
  live: 'green',
  idle: 'yellow',
  ended: 'gray',
  // No watcher heartbeat at all - same severity class as an offline runner.
  stale: 'red',
};

function CliSessionRow({ session }: { session: CliSession }) {
  return (
    <Stack gap={2}>
      <Group gap="xs" wrap="nowrap">
        <Badge
          variant="filled"
          color={LIVENESS_COLORS[session.liveness]}
          size="sm"
        >
          {LIVENESS_LABELS[session.liveness]}
        </Badge>
        <Text size="sm" fw={500} style={{ minWidth: 0 }} truncate>
          {session.title ?? session.branch ?? session.sessionId}
        </Text>
        {session.pr && (
          <Anchor
            href={session.pr.url}
            target="_blank"
            rel="noreferrer"
            size="xs"
            style={{ marginLeft: 'auto', flexShrink: 0 }}
          >
            PR #{session.pr.number} ↗
          </Anchor>
        )}
      </Group>
      <Group gap={6} wrap="wrap">
        {session.host && (
          <Text size="xs" c="dimmed">
            {session.host}
          </Text>
        )}
        {session.branch && (
          <Text size="xs" c="dimmed">
            {session.branch}
            {session.worktree ? ` (${session.worktree})` : ''}
          </Text>
        )}
        {session.model && (
          <Text size="xs" c="dimmed">
            {session.model}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          {session.turns} turns
        </Text>
        <Text size="xs" c="dimmed">
          {formatTokenCount(session.totalTokens)} tokens
        </Text>
        <Text size="xs" c="dimmed">
          last active {formatRelativeTime(session.lastActivityAt)}
        </Text>
      </Group>
    </Stack>
  );
}

export function AgentActivityPanel({
  activity,
  cliSessions = [],
}: {
  activity: AgentActivity;
  cliSessions?: CliSession[];
}) {
  const { liveRuns, recentRuns, runners } = activity;
  const allOffline =
    runners !== undefined &&
    runners.length > 0 &&
    runners.every((runner) => !runner.online);

  return (
    <Card withBorder radius="md" padding="md" mb="xl">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <Title order={2} size="h4">
            Agent Activity
          </Title>
          <Group gap={6} wrap="wrap" justify="flex-end">
            {runners === undefined ? (
              <Text size="xs" c="dimmed">
                Runner status unavailable
              </Text>
            ) : (
              runners.map((runner) => (
                <RunnerBadge key={runner.name} runner={runner} />
              ))
            )}
          </Group>
        </Group>

        {allOffline && (
          <Alert color="red" variant="light">
            All agent runners are offline — dispatched runs will queue but never
            start. Check the runner fleet before retriggering anything.
          </Alert>
        )}

        {liveRuns.length === 0 ? (
          <Text size="sm" c="dimmed">
            No agent runs in flight.
          </Text>
        ) : (
          <Stack gap="xs">
            {liveRuns.map((run) => (
              <LiveRunRow key={run.id} run={run} />
            ))}
          </Stack>
        )}

        {recentRuns.length > 0 && (
          <>
            <Text size="xs" c="dimmed" fw={600} tt="uppercase">
              Recent runs
            </Text>
            <Stack gap={6}>
              {recentRuns.map((run) => (
                <RecentRunRow key={run.id} run={run} />
              ))}
            </Stack>
          </>
        )}

        {cliSessions.length > 0 && (
          <>
            <Text size="xs" c="dimmed" fw={600} tt="uppercase">
              CLI sessions
            </Text>
            <Stack gap="xs">
              {[...cliSessions]
                .sort(
                  (a, b) =>
                    LIVENESS_SORT_ORDER[a.liveness] -
                    LIVENESS_SORT_ORDER[b.liveness],
                )
                .map((session) => (
                  <CliSessionRow key={session.sessionId} session={session} />
                ))}
            </Stack>
          </>
        )}
      </Stack>
    </Card>
  );
}
