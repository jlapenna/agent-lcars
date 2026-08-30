import type { DispatchOutcomeKind } from '@agent-lcars/dispatch-contracts';
import type {
  IssueAgentSessionDoc,
  RunStatusClassification,
  SessionAgent,
  SessionSource,
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
  duplicateLivePipelineGroups,
  findStalledQueuedRun,
  groupLiveRunsByIssue,
  issueUrlForRun,
  MAX_TURNS_BUDGET,
  RUN_TIMEOUT_MINUTES,
} from '../lib/agent-activity';
import type { CliSession } from '../lib/cli-sessions';
import { shareArtifactUrl } from '../lib/deployment';
import {
  getWatchedRepos,
  repoDisplayName,
  repoKey,
} from '../lib/github-client';
import { classifyAgentRun } from '../lib/run-classification';
import { ArtifactPreviewToggle } from './artifact-viewer';
import { Eyebrow } from './eyebrow';
import { formatCost, formatDuration } from './format';
import { lcarsPanelStyle } from './lcars';
import { RelativeTime } from './relative-time';
import { RepoScopeBadge } from './repo-scope-badge';
import { SessionStatusLine } from './session-status-line';
import { TakeoverCommand } from './takeover-command';

// Labels/colors are keyed by the run-status classifier's own output
// (@agent-lcars/telemetry's classifyRunStatus, wrapped for this app by
// classifyAgentRun) rather than a presentation-local conclusion - this is also
// where the old "cancelled at ~the timeout budget -> show 'timeout'
// instead" special case now lives, moved into the classifier itself so
// there's one source of truth instead of a UI-local re-derivation.
// Exported (mirroring PipelineBadge/FleetChip's #3024 precedent) so
// run rows reuse the identical mapping instead of a second hand-rolled
// status-to-color ternary.
export const STATUS_LABELS: Record<RunStatusClassification, string> = {
  running: 'running',
  succeeded: 'success',
  failed: 'failed',
  timeout: 'timeout',
  cancelled: 'cancelled',
  'silent-error': 'silent error',
};

export const STATUS_COLORS: Record<RunStatusClassification, string> = {
  running: 'blue',
  succeeded: 'green',
  failed: 'red',
  timeout: 'yellow',
  cancelled: 'yellow',
  'silent-error': 'orange',
};

export const OUTCOME_LABELS: Record<DispatchOutcomeKind, string> = {
  'pull-request': 'pull request',
  'merged-deliverable': 'merged',
  'unknown-success': 'unclassified success',
};

export const OUTCOME_COLORS: Record<DispatchOutcomeKind, string> = {
  'pull-request': 'green',
  'merged-deliverable': 'green',
  'unknown-success': 'gray',
};

export function DispatchOutcomeBadge({
  outcome,
}: {
  outcome: DispatchOutcomeKind;
}) {
  return (
    <Badge
      variant="outline"
      color={OUTCOME_COLORS[outcome]}
      size="sm"
      data-testid="dispatch-outcome"
    >
      {OUTCOME_LABELS[outcome]}
    </Badge>
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

type ActivityRowVariant = 'detail' | 'operations';

function taskHrefForRun(run: AgentRun, item?: RunItemRef): string | undefined {
  const issueNumber = item?.number ?? run.issueNumber;
  if (issueNumber === undefined) return workHrefForRun(run);
  return `/task/${run.repo.owner}/${run.repo.name}/${issueNumber}`;
}

/**
 * A native work item's authoritative `workId` links directly to its detail
 * page, the same way `taskHrefForRun`/`issueUrlForRun` link issue-anchored
 * activity.
 */
function workHrefForRun(run: AgentRun): string | undefined {
  return run.workId ? `/work/${run.workId}` : undefined;
}

function operationsRunTitle(run: AgentRun): string {
  return run.displayTitle;
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
// from PIPELINE_LABELS/PIPELINE_COLORS above, which tag an authoritative Run
// by its selected provider - a
// session's `agent` instead names which tool actually produced the
// transcript, an orthogonal axis that matters once OpenCode (or a non-Claude
// CLI) starts shipping its own session docs.
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

// How a session's transcript reached the console: streamed live off a
// developer's machine by the watcher (`cli`) or reported by a worker
// session (`issue-agent`). Orthogonal to AGENT_* above (*which* tool
// wrote the transcript) - a codex session can arrive by either route.
const SOURCE_LABELS: Record<SessionSource, string> = {
  cli: 'cli',
  'issue-agent': 'agent',
};

const SOURCE_COLORS: Record<SessionSource, string> = {
  cli: 'blue',
  'issue-agent': 'violet',
};

/**
 * Session-provenance badge, shared by the /sessions archive (table and
 * card layouts) and the session detail header. Those three call sites each
 * carried their own inline `source === 'cli' ? 'blue' : 'violet'` copy of
 * this mapping until #43 - they agreed, but nothing made them agree, so a
 * tweak to one would have drifted silently from the others.
 */
export function SourceBadge({
  source,
  size,
}: {
  source: SessionSource;
  size?: string;
}) {
  return (
    <Badge variant="outline" size={size} color={SOURCE_COLORS[source]}>
      {SOURCE_LABELS[source]}
    </Badge>
  );
}

/**
 * Which watched repo an item/run/session belongs to. Renders nothing when
 * only one repo is configured - the overwhelmingly common case today - so
 * every row stays exactly as quiet as it was before multi-repo support
 * existed, matching AgentBadge's "quiet unless it's informative" precedent.
 */
export function RepoBadge({ repo }: { repo: { owner: string; name: string } }) {
  const watchedRepos = getWatchedRepos();
  if (watchedRepos.length <= 1) {
    return null;
  }
  // Re-resolve against the current config rather than trusting `repo`'s own
  // `alias` field: `repo` may be a run/session record that predates the
  // repo's alias being set (or that was fetched straight from stored
  // telemetry, never touching getWatchedRepos() at all), so the config is
  // the only reliably up to date source of truth for display purposes.
  const configured = watchedRepos.find(
    (watched) => watched.owner === repo.owner && watched.name === repo.name,
  );
  return (
    <RepoScopeBadge
      repoKey={repoKey(configured ?? repo)}
      display={repoDisplayName(configured ?? repo)}
    />
  );
}

/**
 * A dimmed scale-set capacity chip when the fleet has any online runners;
 * nothing at all when it is scaled to zero. This is intentionally not direct
 * queue-executor occupancy: queued/claimed/running work comes from durable
 * orchestrator Run records elsewhere in the activity view.
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
      {fleet.online} scale-set runner{fleet.online === 1 ? '' : 's'} active
      {fleet.busy > 0 ? ` (${fleet.busy} busy)` : ''}
    </Text>
  );
}

function ScreenshotStableDuration({ seconds }: { seconds: number }) {
  return (
    <span data-screenshot="hide" data-screenshot-width="duration">
      {formatDuration(seconds)}
    </span>
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
      A run has been queued for{' '}
      <ScreenshotStableDuration seconds={stalledRun.elapsedSeconds} /> — the
      runner autoscaler may not be supplying runners.
    </Alert>
  );
}

export function LiveRunRow({
  run,
  item,
  session,
  variant = 'detail',
}: {
  run: AgentRun;
  item?: RunItemRef;
  /** The joined `issue-agent` session doc for this run (by runId), when the
   * telemetry shipper has one - powers the turns/cost budget gauges below
   * the wall-clock bar. Undefined renders exactly as before this telemetry
   * existed (PRD user story 16) - no empty chrome, no "unavailable" noise. */
  session?: IssueAgentSessionDoc;
  variant?: ActivityRowVariant;
}) {
  const budgetFraction = run.elapsedSeconds / (RUN_TIMEOUT_MINUTES * 60);

  if (variant === 'operations') {
    const taskHref = taskHrefForRun(run, item);
    const actionHref = taskHref ?? run.url;
    return (
      <div className="operations-row" data-testid="current-run-row">
        <Stack gap={5} style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} truncate>
            {item ? `#${item.number} ${item.title}` : operationsRunTitle(run)}
          </Text>
          <Group gap="xs" wrap="wrap">
            <Badge
              variant="filled"
              color={run.status === 'running' ? 'blue' : 'gray'}
              size="sm"
              style={{ flexShrink: 0 }}
            >
              {run.status === 'running' ? 'running' : 'queued'}
            </Badge>
            <RepoBadge repo={run.repo} />
            <Text size="xs" c="dimmed">
              {run.status === 'running' ? (
                <>
                  <ScreenshotStableDuration seconds={run.elapsedSeconds} /> of{' '}
                  {RUN_TIMEOUT_MINUTES}m budget used
                </>
              ) : (
                <>
                  queued for{' '}
                  <ScreenshotStableDuration seconds={run.elapsedSeconds} />
                </>
              )}
            </Text>
          </Group>
          {run.status === 'running' && (
            <Progress
              value={Math.min(100, budgetFraction * 100)}
              color={budgetColor(budgetFraction)}
              size="sm"
              aria-label="Run wall-clock budget"
            />
          )}
        </Stack>
        <Group gap="xs" wrap="nowrap" className="operations-row__actions">
          <Anchor
            href={actionHref}
            target={taskHref ? undefined : '_blank'}
            rel={taskHref ? undefined : 'noreferrer'}
            size="sm"
            className="operations-primary-action"
            data-testid="current-run-primary-action"
          >
            {taskHref ? 'Open task' : 'Inspect run'}
            {!taskHref && ' ↗'}
          </Anchor>
        </Group>
      </div>
    );
  }

  return (
    <Stack gap={4}>
      <Anchor
        href={
          item?.url ?? issueUrlForRun(run) ?? workHrefForRun(run) ?? run.url
        }
        target="_blank"
        rel="noreferrer"
        size="sm"
        fw={600}
        c="inherit"
        truncate
        style={{ minWidth: 0 }}
        data-testid="live-run-issue-link"
      >
        {item ? `#${item.number} ${item.title}` : run.displayTitle}
      </Anchor>
      <Group gap="xs" wrap="wrap">
        <Badge
          variant="filled"
          color={run.status === 'running' ? 'blue' : 'gray'}
          size="sm"
          style={{ flexShrink: 0 }}
        >
          {run.status === 'running' ? 'running' : 'queued'}
        </Badge>
        <PipelineBadge pipeline={run.pipeline} />
        <RepoBadge repo={run.repo} />
      </Group>
      <Group gap={6} wrap="nowrap">
        <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
          {run.status === 'running' ? (
            <>
              <ScreenshotStableDuration seconds={run.elapsedSeconds} /> of{' '}
              {RUN_TIMEOUT_MINUTES}m
            </>
          ) : (
            <>
              queued <ScreenshotStableDuration seconds={run.elapsedSeconds} />
            </>
          )}
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
          {session && (
            <Anchor
              href={`/sessions/${session.sessionId}`}
              size="xs"
              c="dimmed"
              data-testid="live-run-session-link"
            >
              session
            </Anchor>
          )}
        </Group>
      </Group>
      {run.status === 'running' && (
        <Progress
          value={Math.min(100, budgetFraction * 100)}
          color={budgetColor(budgetFraction)}
          size="sm"
          aria-label="Run wall-clock budget"
        />
      )}
      {run.status === 'running' &&
        session &&
        // OpenCode has no turn cap, so the turn gauge is Claude-only - see
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
 * Every run in a `LiveRunGroupList` group is already live (queued/running -
 * that's this whole panel's scope), so a pipeline appearing more than once
 * in one group is unambiguously a duplicate dispatch, not a status-mix
 * artifact. Returns e.g. `"2 claude"` per duplicated pipeline, undefined
 * when the group's runs are each on a distinct pipeline (a genuine
 * cross-pipeline race, not an anomaly - see #306's LogicalWork model, which
 * treats these two cases distinctly for exactly this reason).
 */
function duplicatePipelineSummary(runs: AgentRun[]): string | undefined {
  const duplicated = duplicateLivePipelineGroups(runs);
  if (duplicated.size === 0) return undefined;
  return Array.from(duplicated.entries())
    .map(([pipeline, group]) => `${group.length} ${pipeline}`)
    .join(', ');
}

/**
 * Renders `liveRuns` clustered by the issue/PR they're working
 * (`groupLiveRunsByIssue`), so two runs racing the same item - a second
 * pipeline dispatched onto it, or a genuine duplicate dispatch on the same
 * pipeline - show up visibly together instead of scattered across the flat
 * list (#239) or, worse, silently reduced to one representative row (#306 -
 * `getAgentActivity` no longer collapses duplicates before this renders, so
 * every attempt this component receives is real evidence). A group of one
 * renders exactly as a bare `LiveRunRow` always has; only a group of two or
 * more gets the clustering chrome, so the overwhelmingly common single-run
 * case is unchanged.
 */
export function LiveRunGroupList({
  liveRuns,
  itemsByRunId = {},
  sessionsByRunId = {},
  variant = 'detail',
}: {
  liveRuns: AgentRun[];
  itemsByRunId?: Record<string, RunItemRef>;
  sessionsByRunId?: Record<string, IssueAgentSessionDoc>;
  variant?: ActivityRowVariant;
}) {
  return (
    <Stack gap="xs">
      {groupLiveRunsByIssue(liveRuns).map((group) => {
        const rows = group.runs.map((run) => (
          <LiveRunRow
            key={run.id}
            run={run}
            item={itemsByRunId[run.id]}
            session={sessionsByRunId[run.id]}
            variant={variant}
          />
        ));
        if (group.runs.length === 1) {
          return rows[0];
        }
        const item = itemsByRunId[group.runs[0].id];
        const duplicateSummary = duplicatePipelineSummary(group.runs);
        const repo = group.runs[0].repo;
        return (
          <Stack
            key={group.key}
            gap={6}
            data-testid={`live-run-group-${group.issueNumber}`}
            style={{
              borderLeft: `2px solid var(--mantine-color-${duplicateSummary ? 'red' : 'blue'}-4)`,
              paddingLeft: 8,
            }}
          >
            <Group gap={6} wrap="wrap">
              <Text size="xs" c="dimmed" fw={600}>
                {item
                  ? `#${item.number} ${item.title}`
                  : `#${group.issueNumber}`}{' '}
                · {group.runs.length} runs
              </Text>
              {group.issueNumber !== undefined && (
                <Anchor
                  href={`/task/${repo.owner}/${repo.name}/${group.issueNumber}`}
                  size="xs"
                  c="dimmed"
                  data-testid={`live-run-group-${group.issueNumber}-history`}
                >
                  attempt history
                </Anchor>
              )}
            </Group>
            {duplicateSummary && (
              <Alert
                color="red"
                variant="light"
                py={4}
                data-testid={`live-run-group-${group.issueNumber}-duplicate`}
              >
                Duplicate attempts: {duplicateSummary} queued/running for this
                task at once.
              </Alert>
            )}
            <Stack gap="xs">{rows}</Stack>
          </Stack>
        );
      })}
    </Stack>
  );
}

/**
 * A finished run row: unlike the old title-only text, the run's title is
 * now a real link to the issue/PR it worked (derived from `issueNumber`),
 * so a finished run can be followed straight to its outcome instead of only
 * to an opaque execution log. Runs without a GitHub anchor
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
  variant = 'detail',
}: {
  run: AgentRun;
  session?: IssueAgentSessionDoc;
  variant?: ActivityRowVariant;
}) {
  const classification = classifyAgentRun(run, session);
  const issueUrl = issueUrlForRun(run);

  if (variant === 'operations') {
    const taskHref = taskHrefForRun(run);
    const actionHref = taskHref ?? issueUrl ?? run.url;
    const successful = classification.status === 'succeeded';
    return (
      <div
        className="operations-row"
        data-testid="finished-run-row"
        data-status={classification.status}
      >
        <Stack gap={5} style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} truncate>
            {operationsRunTitle(run)}
          </Text>
          <Group gap="xs" wrap="wrap">
            <Badge
              variant="light"
              color={STATUS_COLORS[classification.status]}
              size="sm"
              style={{ flexShrink: 0 }}
              data-testid="recent-run-conclusion"
            >
              {STATUS_LABELS[classification.status]}
            </Badge>
            <RepoBadge repo={run.repo} />
          </Group>
          {classification.diagnosis && (
            <Text size="xs" c="orange" data-testid="finished-run-diagnosis">
              {classification.diagnosis}
            </Text>
          )}
        </Stack>
        <Anchor
          href={actionHref}
          target={taskHref ? undefined : '_blank'}
          rel={taskHref ? undefined : 'noreferrer'}
          size="sm"
          className="operations-primary-action"
          data-testid="outcome-primary-action"
        >
          {successful ? 'View result' : 'Investigate'}
          {!taskHref && ' ↗'}
        </Anchor>
      </div>
    );
  }

  return (
    <Stack gap={2} data-testid="finished-run-row">
      <Anchor
        href={issueUrl ?? workHrefForRun(run) ?? run.url}
        target="_blank"
        rel="noreferrer"
        size="sm"
        fw={600}
        c="inherit"
        truncate
        style={{ minWidth: 0 }}
        data-testid="recent-run-issue-link"
      >
        {run.displayTitle}
      </Anchor>
      <Group gap="xs" wrap="wrap">
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
        <RepoBadge repo={run.repo} />
      </Group>
      <Group gap="xs" wrap="nowrap">
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
          {formatDuration(run.elapsedSeconds)} · finished{' '}
          <RelativeTime iso={run.updatedAt} />
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

/** A transcript UUID is a routing key, not a useful label on the Bridge. */
function cliSessionLabel(session: CliSession): string {
  return (
    session.title ??
    session.branch ??
    (session.host ? `Session on ${session.host}` : 'Untitled CLI session')
  );
}

export function CliSessionRow({
  session,
  takeoverCommand,
  variant = 'detail',
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
  variant?: ActivityRowVariant;
}) {
  const { host, artifacts } = session;
  const label = cliSessionLabel(session);

  if (variant === 'operations') {
    return (
      <div
        className="operations-row"
        data-testid={`cli-session-${session.sessionId}`}
      >
        <Stack gap={5} style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} truncate>
            {label}
          </Text>
          <SessionStatusLine
            status={session.status}
            statusUpdatedAt={session.statusUpdatedAt}
            liveness={session.liveness}
          />
          <Group gap="xs" wrap="wrap">
            <Badge
              variant="filled"
              color={LIVENESS_COLORS[session.liveness]}
              size="sm"
              style={{ flexShrink: 0 }}
              data-testid="cli-session-liveness"
            >
              {LIVENESS_LABELS[session.liveness]}
            </Badge>
            <AgentBadge agent={session.agent} />
            {session.repo && <RepoBadge repo={session.repo} />}
          </Group>
        </Stack>
        <Anchor
          href={`/sessions/${session.sessionId}`}
          size="sm"
          className="operations-primary-action"
          data-testid="cli-session-link"
        >
          Open session
        </Anchor>
      </div>
    );
  }

  return (
    <Stack gap={2} data-testid={`cli-session-${session.sessionId}`}>
      <Anchor
        href={`/sessions/${session.sessionId}`}
        size="sm"
        fw={600}
        c="inherit"
        truncate
        style={{ minWidth: 0 }}
        className="cli-session-title-link"
        data-testid="cli-session-link"
      >
        {label}
      </Anchor>
      <SessionStatusLine
        status={session.status}
        statusUpdatedAt={session.statusUpdatedAt}
        liveness={session.liveness}
      />
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
        <AgentBadge agent={session.agent} />
        {session.repo && <RepoBadge repo={session.repo} />}
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
          last active <RelativeTime iso={session.lastActivityAt} />
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
 * The Bridge's action-first operational summary. Work that can be acted on
 * now and the latest meaningful outcomes stay visible; historical CLI
 * sessions and full-fidelity run evidence live on their dedicated routes.
 */
export function AgentActivityPanel({
  activity,
  cliSessions = [],
  itemsByRunId = {},
  sessionsByRunId = {},
  repoFilter,
}: {
  activity: AgentActivity;
  cliSessions?: CliSession[];
  itemsByRunId?: Record<string, RunItemRef>;
  /** Joined `issue-agent` session docs, keyed by `AgentRun.id` - see
   * `indexSessionsByRunId` in run-classification.ts. Absent/empty
   * renders exactly as before this telemetry existed (PRD user story 16). */
  sessionsByRunId?: Record<string, IssueAgentSessionDoc>;
  /** Keep the Bridge's active repository scope when opening full history. */
  repoFilter?: string;
}) {
  const { liveRuns, recentRuns, fleet } = activity;
  const outcomesHref = repoFilter
    ? `/agents?${new URLSearchParams({ repo: repoFilter })}`
    : '/agents';

  const activeSessions = cliSessions.filter(
    (session) => session.liveness === 'live' || session.liveness === 'idle',
  );

  return (
    <Card
      withBorder
      radius="md"
      padding="md"
      mb="xl"
      className="lcars-panel operations-panel"
      style={lcarsPanelStyle('amber')}
    >
      <Stack gap="md">
        <Group justify="space-between" wrap="nowrap">
          <Title order={2}>Operations</Title>
          <Group gap={6} wrap="wrap" justify="flex-end">
            <FleetChip fleet={fleet} />
          </Group>
        </Group>
        <Text size="sm" c="dimmed" className="operations-panel__intro">
          Act on current work and review the latest outcomes.
        </Text>

        <QueueHealthAlert liveRuns={liveRuns} />

        <section className="operations-section" data-testid="current-work">
          <Title order={3} size="h4" mb="xs">
            Current Work
          </Title>
          {liveRuns.length === 0 && activeSessions.length === 0 ? (
            <Text size="sm" c="dimmed">
              No work is currently in flight.
            </Text>
          ) : (
            <Stack gap="sm">
              {liveRuns.length > 0 && (
                <LiveRunGroupList
                  liveRuns={liveRuns}
                  itemsByRunId={itemsByRunId}
                  sessionsByRunId={sessionsByRunId}
                  variant="operations"
                />
              )}
              {activeSessions.length > 0 && (
                <Stack gap={0}>
                  <Eyebrow>CLI sessions</Eyebrow>
                  {activeSessions.map((session) => (
                    <CliSessionRow
                      key={session.sessionId}
                      session={session}
                      variant="operations"
                    />
                  ))}
                </Stack>
              )}
            </Stack>
          )}
        </section>

        {recentRuns.length > 0 && (
          <section className="operations-section" data-testid="latest-outcomes">
            <Title order={3} size="h4" mb={2}>
              Latest Outcomes
            </Title>
            <Text size="sm" c="dimmed" mb="xs">
              The five most recent agent results, with failures called out.
            </Text>
            <Stack gap={0}>
              {recentRuns.slice(0, 5).map((run) => (
                <FinishedRunRow
                  key={run.id}
                  run={run}
                  session={sessionsByRunId[run.id]}
                  variant="operations"
                />
              ))}
            </Stack>
            <Anchor
              href={outcomesHref}
              size="sm"
              className="operations-more-link"
            >
              View all outcomes →
            </Anchor>
          </section>
        )}

        {recentRuns.length === 0 && (
          <section className="operations-section">
            <Title order={3} size="h4" mb="xs">
              Latest Outcomes
            </Title>
            <Text size="sm" c="dimmed">
              No recent agent outcomes.
            </Text>
          </section>
        )}
      </Stack>
    </Card>
  );
}
