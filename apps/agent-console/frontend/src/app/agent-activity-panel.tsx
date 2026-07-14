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
import { ArtifactPreviewToggle } from './artifact-viewer';
import { CancelRunButton } from './cancel-run-button';
import {
  formatDuration,
  formatRelativeTime,
  formatTokenCount,
  shareArtifactUrl,
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

/** The issue/PR a live run is working, joined server-side in page.tsx. */
export interface RunItemRef {
  number: number;
  title: string;
  url: string;
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

/**
 * One green badge when the whole fleet is healthy and idle; individual
 * badges only when some runner is busy or offline. Fleet status is context,
 * not work - it only deserves pixels when it's abnormal.
 */
function RunnerSummary({ runners }: { runners?: RunnerStatus[] }) {
  if (runners === undefined) {
    return (
      <Text size="xs" c="dimmed">
        Runner status unavailable
      </Text>
    );
  }
  const allIdle = runners.every((runner) => runner.online && !runner.busy);
  if (runners.length > 0 && allIdle) {
    return (
      <Badge variant="light" color="green" size="sm">
        {runners.length} runners idle
      </Badge>
    );
  }
  return (
    <>
      {runners.map((runner) => (
        <RunnerBadge key={runner.name} runner={runner} />
      ))}
    </>
  );
}

function LiveRunRow({ run, item }: { run: AgentRun; item?: RunItemRef }) {
  const budgetFraction = run.elapsedSeconds / (RUN_TIMEOUT_MINUTES * 60);
  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="nowrap">
        <Badge
          variant="filled"
          color={run.status === 'running' ? 'blue' : 'gray'}
          size="sm"
          style={{ flexShrink: 0 }}
        >
          {run.status === 'running' ? 'running' : 'queued'}
        </Badge>
        <Anchor
          href={item?.url ?? run.url}
          target="_blank"
          rel="noreferrer"
          size="sm"
          fw={500}
          c="inherit"
          truncate
          style={{ minWidth: 0 }}
        >
          {item ? `#${item.number} ${item.title}` : run.displayTitle}
        </Anchor>
        <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
          {run.status === 'running'
            ? `${formatDuration(run.elapsedSeconds)} of ${RUN_TIMEOUT_MINUTES}m`
            : `queued ${formatDuration(run.elapsedSeconds)}`}
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
      <Badge
        variant="light"
        color={CONCLUSION_COLORS[conclusion]}
        size="sm"
        style={{ flexShrink: 0 }}
        data-testid="recent-run-conclusion"
      >
        {isLikelyTimeout(run) ? 'timeout' : CONCLUSION_LABELS[conclusion]}
      </Badge>
      <Text size="xs" c="dimmed" truncate style={{ minWidth: 0 }}>
        {run.displayTitle}
      </Text>
      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
        {formatDuration(run.elapsedSeconds)} · finished{' '}
        {formatRelativeTime(run.updatedAt)}
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
  const { host, artifacts } = session;
  return (
    <Stack gap={2} data-testid={`cli-session-${session.sessionId}`}>
      <Group gap="xs" wrap="nowrap">
        <Badge
          variant="filled"
          color={LIVENESS_COLORS[session.liveness]}
          size="sm"
          style={{ flexShrink: 0 }}
          data-testid="cli-session-liveness"
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
      {host && artifacts && artifacts.length > 0 && (
        <Stack gap={2}>
          <Group gap={6} wrap="wrap">
            <Text size="xs" c="dimmed">
              Artifacts:
            </Text>
            {artifacts.map((filename) => {
              const url = shareArtifactUrl(host, session.sessionId, filename);
              return (
                <Group key={filename} gap={4} wrap="nowrap">
                  <Anchor href={url} target="_blank" rel="noreferrer" size="xs">
                    {filename} ↗
                  </Anchor>
                  <ArtifactPreviewToggle url={url} filename={filename} />
                </Group>
              );
            })}
          </Group>
        </Stack>
      )}
    </Stack>
  );
}

/**
 * "In Flight": everything currently moving without the maintainer - live
 * agent runs (joined to their issue when possible) and live/idle CLI
 * sessions. Finished work (recent runs, ended/stale sessions) is history,
 * not activity, so it lives behind collapsed disclosures; native <details>
 * keeps this a server component.
 */
export function AgentActivityPanel({
  activity,
  cliSessions = [],
  itemsByRunId = {},
}: {
  activity: AgentActivity;
  cliSessions?: CliSession[];
  itemsByRunId?: Record<number, RunItemRef>;
}) {
  const { liveRuns, recentRuns, runners } = activity;
  const allOffline =
    runners !== undefined &&
    runners.length > 0 &&
    runners.every((runner) => !runner.online);

  const activeSessions = cliSessions.filter(
    (session) => session.liveness === 'live' || session.liveness === 'idle',
  );
  const finishedSessions = cliSessions.filter(
    (session) => session.liveness !== 'live' && session.liveness !== 'idle',
  );

  return (
    <Card withBorder radius="md" padding="md" mb="xl">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <Title order={2} size="h4">
            In Flight
          </Title>
          <Group gap={6} wrap="wrap" justify="flex-end">
            <RunnerSummary runners={runners} />
          </Group>
        </Group>

        {allOffline && (
          <Alert color="red" variant="light">
            All agent runners are offline — dispatched runs will queue but never
            start. Check the runner fleet before retriggering anything.
          </Alert>
        )}

        {liveRuns.length === 0 && activeSessions.length === 0 && (
          <Text size="sm" c="dimmed">
            No agent runs or CLI sessions in flight.
          </Text>
        )}

        {liveRuns.length > 0 && (
          <Stack gap="xs">
            {liveRuns.map((run) => (
              <LiveRunRow key={run.id} run={run} item={itemsByRunId[run.id]} />
            ))}
          </Stack>
        )}

        {activeSessions.length > 0 && (
          <>
            <Text size="xs" c="dimmed" fw={600} tt="uppercase">
              CLI sessions
            </Text>
            <Stack gap="xs">
              {activeSessions.map((session) => (
                <CliSessionRow key={session.sessionId} session={session} />
              ))}
            </Stack>
          </>
        )}

        {recentRuns.length > 0 && (
          <details data-testid="recent-runs">
            <summary style={{ cursor: 'pointer' }}>
              <Text
                size="xs"
                c="dimmed"
                fw={600}
                tt="uppercase"
                component="span"
              >
                Recent runs ({recentRuns.length})
              </Text>
            </summary>
            <Stack gap={6} mt="xs">
              {recentRuns.map((run) => (
                <RecentRunRow key={run.id} run={run} />
              ))}
            </Stack>
          </details>
        )}

        {finishedSessions.length > 0 && (
          <details data-testid="recent-sessions">
            <summary style={{ cursor: 'pointer' }}>
              <Text
                size="xs"
                c="dimmed"
                fw={600}
                tt="uppercase"
                component="span"
              >
                Recent CLI sessions ({finishedSessions.length})
              </Text>
            </summary>
            <Stack gap="xs" mt="xs">
              {finishedSessions.map((session) => (
                <CliSessionRow key={session.sessionId} session={session} />
              ))}
            </Stack>
          </details>
        )}
      </Stack>
    </Card>
  );
}
