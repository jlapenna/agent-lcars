import type {
  IssueAgentSessionDoc,
  RunStatusClassification,
  SessionAgent,
} from '@agent-lcars/telemetry';
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
  AgentPipeline,
  AgentRun,
  FleetSummary,
} from '../lib/agent-activity';
import {
  displayRunTitle,
  findStalledQueuedRun,
  issueUrlForRun,
  MAX_TURNS_BUDGET,
  RUN_TIMEOUT_MINUTES,
} from '../lib/agent-activity';
import type { CliSession } from '../lib/cli-sessions';
import { classifyAgentRun } from '../lib/run-classification';
import { ArtifactPreviewToggle } from './artifact-viewer';
import { CancelRunButton } from './cancel-run-button';
import {
  formatCost,
  formatDuration,
  formatRelativeTime,
  shareArtifactUrl,
} from './format';
import { TakeoverCommand } from './takeover-command';

// Labels/colors are keyed by the run-status classifier's own output
// (@agent-lcars/telemetry's classifyRunStatus, wrapped for this app by
// classifyAgentRun) rather than the raw GitHub conclusion - this is also
// where the old "cancelled at ~the timeout budget -> show 'timeout'
// instead" special case now lives, moved into the classifier itself so
// there's one source of truth instead of a UI-local re-derivation.
const STATUS_LABELS: Record<RunStatusClassification, string> = {
  running: 'running',
  succeeded: 'success',
  failed: 'failed',
  timeout: 'timeout',
  cancelled: 'cancelled',
  'silent-error': 'silent error',
};

const STATUS_COLORS: Record<RunStatusClassification, string> = {
  running: 'blue',
  succeeded: 'green',
  failed: 'red',
  timeout: 'yellow',
  cancelled: 'yellow',
  'silent-error': 'orange',
};

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

const PIPELINE_LABELS: Record<AgentPipeline, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

const PIPELINE_COLORS: Record<AgentPipeline, string> = {
  claude: 'blue',
  codex: 'teal',
  opencode: 'violet',
};

/**
 * Subtle pipeline source tag on run rows - context, not status, so it stays
 * small and outlined rather than competing visually with the
 * status/conclusion badge next to it. Exported (#3024) for reuse on the
 * /agents page, which needs the same badge outside a run/session row (e.g.
 * the fleet snapshot bar's per-pipeline live counts).
 */
export function PipelineBadge({ pipeline }: { pipeline: AgentPipeline }) {
  return (
    <Badge
      variant="outline"
      color={PIPELINE_COLORS[pipeline]}
      size="xs"
      style={{ flexShrink: 0 }}
    >
      {PIPELINE_LABELS[pipeline]}
    </Badge>
  );
}

// Labels/colors for the *coding agent* that produced a session (#3123 phase
// 1 - the discriminator + watcher/adapter seam this badge is the only
// visible surface of so far; no non-claude-code agent ships yet). Distinct
// from PIPELINE_LABELS/PIPELINE_COLORS above, which tag a GitHub Actions
// *run* by which workflow dispatched it (claude.yml vs opencode.yml) - a
// session's `agent` instead names which tool actually produced the
// transcript, an orthogonal axis that matters once opencode.yml (or a
// non-Claude CLI) starts shipping its own session docs.
const AGENT_LABELS: Record<SessionAgent, string> = {
  'claude-code': 'claude code',
  codex: 'codex',
  gemini: 'gemini',
  antigravity: 'antigravity',
  opencode: 'opencode',
};

const AGENT_COLORS: Record<SessionAgent, string> = {
  'claude-code': 'gray',
  codex: 'teal',
  gemini: 'blue',
  antigravity: 'grape',
  opencode: 'violet',
};

/**
 * Session-identity badge: which coding agent produced this session's
 * transcript. Renders nothing for `'claude-code'` - both `sessionAgent()`'s
 * default for any doc predating #3123 and, today, every single session that
 * exists - so the overwhelmingly common case stays visually quiet and only
 * a genuinely different agent earns a badge. Callers resolve the value via
 * `sessionAgent(doc)` (or a view-model field already resolved that way, see
 * `CliSession.agent`/`SessionRow.agent`) rather than passing the raw
 * optional field through.
 */
export function AgentBadge({ agent }: { agent: SessionAgent }) {
  if (agent === 'claude-code') {
    return null;
  }
  return (
    <Badge
      variant="outline"
      color={AGENT_COLORS[agent]}
      size="xs"
      style={{ flexShrink: 0 }}
    >
      {AGENT_LABELS[agent]}
    </Badge>
  );
}

/**
 * A dimmed count chip when the fleet has any online runners; nothing at all
 * when it's scaled to zero. Since #2974's autoscaler scale-set migration,
 * zero registered runners is the normal idle state, not an outage, so it no
 * longer deserves any pixels.
 */
export function FleetChip({ fleet }: { fleet?: FleetSummary }) {
  if (fleet === undefined) {
    return (
      <Text size="xs" c="dimmed" data-testid="fleet-chip">
        Runner status unavailable
      </Text>
    );
  }
  if (fleet.online === 0) return null;
  return (
    <Text size="xs" c="dimmed" data-testid="fleet-chip">
      {fleet.online} runner{fleet.online === 1 ? '' : 's'} active
      {fleet.busy > 0 ? ` (${fleet.busy} busy)` : ''}
    </Text>
  );
}

/**
 * The autoscaler-aware replacement for the old "all runners offline" alert:
 * that condition can no longer fire meaningfully (a scaled-to-zero pool is
 * normal), so the real health signal is a live run stuck waiting for a
 * runner the autoscaler should have supplied by now.
 */
export function QueueHealthAlert({ liveRuns }: { liveRuns: AgentRun[] }) {
  const stalledRun = findStalledQueuedRun(liveRuns);
  if (!stalledRun) return null;
  return (
    <Alert color="red" variant="light" data-testid="queue-health-alert">
      A run has been queued for {formatDuration(stalledRun.elapsedSeconds)} —
      the runner autoscaler may not be supplying runners.
    </Alert>
  );
}

export function LiveRunRow({
  run,
  item,
  session,
}: {
  run: AgentRun;
  item?: RunItemRef;
  /** The joined `issue-agent` session doc for this run (by runId), when the
   * telemetry shipper has one - powers the turns/cost budget gauges below
   * the wall-clock bar. Undefined renders exactly as before this telemetry
   * existed (PRD user story 16) - no empty chrome, no "unavailable" noise. */
  session?: IssueAgentSessionDoc;
}) {
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
        <PipelineBadge pipeline={run.pipeline} />
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
          {item ? `#${item.number} ${item.title}` : displayRunTitle(run)}
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
      {run.status === 'running' &&
        session &&
        // opencode.yml has no turn cap (its action takes no max_turns
        // input), so the turn gauge is claude-pipeline-only - see
        // MAX_TURNS_BUDGET's doc comment.
        (run.pipeline === 'claude' || session.totalCostUsd !== undefined) && (
          <Group gap={6} wrap="wrap">
            {run.pipeline === 'claude' && (
              <Text size="xs" c="dimmed" data-testid="live-run-turns">
                {session.turns} of {MAX_TURNS_BUDGET} turns
              </Text>
            )}
            {session.totalCostUsd !== undefined && (
              <Text size="xs" c="dimmed" data-testid="live-run-cost">
                {formatCost(session.totalCostUsd)}
              </Text>
            )}
          </Group>
        )}
    </Stack>
  );
}

/**
 * A finished run row: unlike the old title-only text, the run's title is
 * now a real link to the issue/PR it worked (derived from `issueNumber`),
 * so a finished run can be followed straight to its outcome instead of only
 * to its raw Actions log. Runs that predate the run-name rollout
 * (`issueUrlForRun` undefined) fall back to the run's own title/url - the
 * same target as the secondary "View run" link.
 *
 * The status badge and any diagnosis line come from the run-status
 * classifier (classifyAgentRun/@agent-lcars/telemetry), joined to the run's
 * session doc by runId when one exists - a silent-error run (GitHub said
 * success, but the session shows a known failure signature or shipped
 * nothing) gets a distinct badge + a short explanation, not just "success".
 */
export function FinishedRunRow({
  run,
  session,
}: {
  run: AgentRun;
  session?: IssueAgentSessionDoc;
}) {
  const classification = classifyAgentRun(run, session);
  const issueUrl = issueUrlForRun(run);
  return (
    <Stack gap={2} data-testid="finished-run-row">
      <Group gap="xs" wrap="nowrap">
        <Badge
          variant="light"
          color={STATUS_COLORS[classification.status]}
          size="sm"
          style={{ flexShrink: 0 }}
          data-testid="recent-run-conclusion"
        >
          {STATUS_LABELS[classification.status]}
        </Badge>
        <PipelineBadge pipeline={run.pipeline} />
        <Anchor
          href={issueUrl ?? run.url}
          target="_blank"
          rel="noreferrer"
          size="xs"
          truncate
          style={{ minWidth: 0 }}
          data-testid="recent-run-issue-link"
        >
          {displayRunTitle(run)}
        </Anchor>
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
        {session && (
          <Anchor
            href={`/sessions/${session.sessionId}`}
            size="xs"
            c="dimmed"
            data-testid="finished-run-session-link"
          >
            session
          </Anchor>
        )}
      </Group>
      {classification.diagnosis && (
        <Text size="xs" c="orange" data-testid="finished-run-diagnosis">
          {classification.diagnosis}
        </Text>
      )}
    </Stack>
  );
}

// Exported (mirroring PipelineBadge/FleetChip's #3024 precedent) for reuse
// on the /sessions archive page's liveness column.
export const LIVENESS_LABELS: Record<CliSession['liveness'], string> = {
  live: 'live',
  idle: 'idle',
  ended: 'ended',
  stale: 'stale',
};

export const LIVENESS_COLORS: Record<CliSession['liveness'], string> = {
  live: 'green',
  idle: 'yellow',
  ended: 'gray',
  // No watcher heartbeat at all - same severity class as an offline runner.
  stale: 'red',
};

export function CliSessionRow({
  session,
  takeoverCommand,
}: {
  session: CliSession;
  /**
   * The takeover command of the action item this session is working, when
   * one exists (see claimed-idle.ts's sessionReferencesItemNumber join,
   * used by the /agents page's Active Agents section). The home page's
   * In Flight panel never passes this - CLI sessions there render exactly
   * as before.
   */
  takeoverCommand?: string;
}) {
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
        <AgentBadge agent={session.agent} />
        <Anchor
          href={`/sessions/${session.sessionId}`}
          size="xs"
          c="dimmed"
          data-testid="cli-session-link"
        >
          session
        </Anchor>
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
        <Text size="xs" c="dimmed">
          last active {formatRelativeTime(session.lastActivityAt)}
        </Text>
      </Group>
      {takeoverCommand && <TakeoverCommand command={takeoverCommand} />}
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
  sessionsByRunId = {},
}: {
  activity: AgentActivity;
  cliSessions?: CliSession[];
  itemsByRunId?: Record<number, RunItemRef>;
  /** Joined `issue-agent` session docs, keyed by `AgentRun.id` - see
   * `indexSessionsByNumericRunId` in run-classification.ts. Absent/empty
   * renders exactly as before this telemetry existed (PRD user story 16). */
  sessionsByRunId?: Record<number, IssueAgentSessionDoc>;
}) {
  const { liveRuns, recentRuns, fleet } = activity;

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
            <FleetChip fleet={fleet} />
          </Group>
        </Group>

        <QueueHealthAlert liveRuns={liveRuns} />

        {liveRuns.length === 0 && activeSessions.length === 0 && (
          <Text size="sm" c="dimmed">
            No agent runs or CLI sessions in flight.
          </Text>
        )}

        {liveRuns.length > 0 && (
          <Stack gap="xs">
            {liveRuns.map((run) => (
              <LiveRunRow
                key={run.id}
                run={run}
                item={itemsByRunId[run.id]}
                session={sessionsByRunId[run.id]}
              />
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
                Recently finished ({recentRuns.length})
              </Text>
            </summary>
            <Stack gap={6} mt="xs">
              {recentRuns.map((run) => (
                <FinishedRunRow
                  key={run.id}
                  run={run}
                  session={sessionsByRunId[run.id]}
                />
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
