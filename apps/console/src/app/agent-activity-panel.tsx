import type {
  IssueAgentSessionDoc,
  RunStatusClassification,
  SessionAgent,
  SessionSource,
} from '@agent-lcars/telemetry';
import type { StoredPipeline } from '@agent-lcars/work';
import {
  Alert,
  Anchor,
  Badge,
  Group,
  Progress,
  Stack,
  Text,
} from '@mantine/core';

import type { AgentRun } from '../lib/agent-activity';
import {
  duplicateLivePipelineGroups,
  findStalledQueuedRun,
  MAX_TURNS_BUDGET,
  RUN_TIMEOUT_MINUTES,
} from '../lib/agent-activity';
import type { CliSession } from '../lib/cli-sessions';
import { sessionLiveViewUrl, shareArtifactUrl } from '../lib/deployment';
import {
  getWatchedRepos,
  repoDisplayName,
  repoKey,
} from '../lib/github-client';
import { classifyAgentRun } from '../lib/run-classification';
import { ArtifactPreviewToggle } from './artifact-viewer';
import { BridgePaneLink } from './bridge-pane-link';
import { runKey } from './bridge-selection';
import { ExecutionStatus } from './execution-status';
import { formatCost, formatDuration } from './format';
import { RelativeTime } from './relative-time';
import { RepoScopeBadge } from './repo-scope-badge';
import { SessionStatusLine } from './session-status-line';

export { FleetChip } from './fleet-status';

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

export function budgetColor(fraction: number): string {
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

/** How many of the most recent outcomes the Bridge's operations panel shows.
 * Exported so the two-panel detail resolver selects from the *same* slice the
 * list renders - a run that ages past this cutoff has no row to select and so
 * must not resolve to detail either. */
export const RECENT_OUTCOMES_LIMIT = 5;

/** A CLI session the Bridge lists as current work. Exported for the same
 * reason as `RECENT_OUTCOMES_LIMIT`: the detail resolver and the list must
 * agree on which sessions exist, or an ended session lingers in the detail
 * pane after its row disappears. */
export function isActiveCliSession(session: CliSession): boolean {
  return session.liveness === 'live' || session.liveness === 'idle';
}

/**
 * The bold leading label on an operational row. On the Bridge's unified
 * two-panel view the row doubles as the master list, so the title becomes the
 * responsive navigation control: its canonical detail route opens on mobile,
 * while desktop changes the Bridge's `?sel=` and opens the row in the right
 * pane. Everywhere else it stays the plain non-interactive text it has always
 * been. Only the operations variant passes `selectHref`, so the /agents detail
 * rows - which render the same components at the `detail` variant - are
 * untouched.
 */
export function RowTitle({
  text,
  mobileHref,
  selectHref,
}: {
  text: string;
  mobileHref?: string;
  selectHref?: string;
}) {
  if (!selectHref) {
    return (
      <Text size="sm" fw={600} truncate>
        {text}
      </Text>
    );
  }
  return (
    <BridgePaneLink
      mobileHref={mobileHref ?? selectHref}
      paneHref={selectHref}
      size="sm"
      fw={600}
      c="inherit"
      td="none"
      truncate
      className="bridge-row-select"
      data-testid="bridge-row-select"
    >
      {text}
    </BridgePaneLink>
  );
}

export function taskHrefForRun(
  run: AgentRun,
  item?: RunItemRef,
): string | undefined {
  if (run.workId) return workHrefForRun(run);
  const issueNumber = item?.number ?? run.issueNumber;
  if (issueNumber === undefined) return workHrefForRun(run);
  return `/task/${run.repo.owner}/${run.repo.name}/${issueNumber}`;
}

/**
 * A native work item's authoritative `workId` links directly to its detail
 * page, the same way `taskHrefForRun`/`issueUrlForRun` link issue-anchored
 * activity.
 */
export function workHrefForRun(run: AgentRun): string | undefined {
  return run.workId ? `/work/${run.workId}` : undefined;
}

/** New title links need a known projection; existing explicit task actions
 * retain their task-history navigation contract. */
export function titleHrefForRun(run: AgentRun, item?: RunItemRef): string {
  if (run.workId || item) return taskHrefForRun(run, item)!;
  return internalRunHref(run);
}

/** Inspect the existing run record without requiring a GitHub projection. */
export function internalRunHref(run: AgentRun): string {
  return `/agents?${new URLSearchParams({ repo: repoKey(run.repo), sel: runKey(run) })}`;
}

type FixedPipeline = Exclude<StoredPipeline, `claw-${string}`>;

const PIPELINE_LABELS: Record<FixedPipeline, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  agy: 'agy',
  goose: 'goose',
  'inbox-summary': 'inbox summary',
  'handoff-summary': 'handoff summary',
};

const PIPELINE_COLORS: Record<FixedPipeline, string> = {
  claude: 'blue',
  codex: 'teal',
  // The default violet outline shade fails AA on the dark ground.
  opencode: 'var(--lcars-periwinkle)',
  agy: 'grape',
  // Internal recipe and summary work is background context, not a coding
  // provider, so it stays neutral.
  goose: 'gray',
  'inbox-summary': 'gray',
  'handoff-summary': 'gray',
};

const isClawPipeline = (
  pipeline: StoredPipeline,
): pipeline is `claw-${string}` => pipeline.startsWith('claw-');

/**
 * Subtle pipeline source tag on run rows - context, not status, so it stays
 * small and outlined rather than competing visually with the
 * status/conclusion badge next to it. Exported (#3024) for reuse on the
 * /agents page, which needs the same badge outside a run/session row (e.g.
 * the fleet snapshot bar's per-pipeline live counts).
 */
export function PipelineBadge({ pipeline }: { pipeline: StoredPipeline }) {
  return (
    <Badge
      variant="outline"
      // A claw runtime is an internal executor, not a coding provider.
      color={isClawPipeline(pipeline) ? 'orange' : PIPELINE_COLORS[pipeline]}
      size="xs"
      style={{ flexShrink: 0 }}
    >
      {isClawPipeline(pipeline)
        ? `claw ${pipeline.slice('claw-'.length)}`
        : PIPELINE_LABELS[pipeline]}
    </Badge>
  );
}

// Labels/colors for the coding agent that produced a session. Distinct from
// PIPELINE_LABELS/PIPELINE_COLORS above, which tag an authoritative Run by
// its selected provider: a session's `agent` instead names the tool that
// actually produced the transcript.
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
  opencode: 'var(--lcars-periwinkle)',
};

/**
 * Session-identity badge: which coding agent produced this session's
 * transcript. Every caller passes the persisted explicit identity, which is
 * always rendered so the console does not imply Claude for another agent.
 */
export function AgentBadge({ agent }: { agent: SessionAgent }) {
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
 * existed.
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

export function ScreenshotStableDuration({ seconds }: { seconds: number }) {
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
    <Stack gap={4} data-testid="current-run-row">
      <Anchor
        href={titleHrefForRun(run, item)}
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
        <ExecutionStatus
          run={{
            state: run.status === 'queued' ? 'pending' : run.status,
            queue: run.queue,
          }}
        />
        <PipelineBadge pipeline={run.pipeline} />
        <RepoBadge repo={run.repo} />
        {(taskHrefForRun(run, item) ?? workHrefForRun(run)) && (
          <Anchor
            size="xs"
            href={`${taskHrefForRun(run, item) ?? workHrefForRun(run)}#run-${encodeURIComponent(run.id)}`}
          >
            Task/run
          </Anchor>
        )}
      </Group>
      <Group gap={6} wrap="wrap" className="agent-run-meta">
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
          className="agent-run-meta__actions"
          style={{ marginLeft: 'auto', flexShrink: 0 }}
        >
          <Anchor
            href={run.url}
            target="_blank"
            rel="noreferrer"
            size="xs"
            c="dimmed"
          >
            {run.url.startsWith('https://github.com/')
              ? 'View run on GitHub ↗'
              : 'View run'}
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
 * Every run in a live-run group is already live (queued/running), so a
 * pipeline appearing more than once in one group is unambiguously a duplicate
 * dispatch, not a status-mix artifact. Returns e.g. `"2 claude"` per
 * duplicated pipeline, undefined when the group's runs are each on a distinct
 * pipeline (a genuine cross-pipeline race, not an anomaly - see #306's
 * LogicalWork model, which treats these two cases distinctly).
 */
export function duplicatePipelineSummary(runs: AgentRun[]): string | undefined {
  const duplicated = duplicateLivePipelineGroups(runs);
  if (duplicated.size === 0) return undefined;
  return Array.from(duplicated.entries())
    .map(([pipeline, group]) => `${group.length} ${pipeline}`)
    .join(', ');
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
}: {
  run: AgentRun;
  session?: IssueAgentSessionDoc;
}) {
  const classification = classifyAgentRun(run, session);

  return (
    <Stack gap={2} data-testid="finished-run-row">
      <Anchor
        href={titleHrefForRun(run)}
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
          size="xs"
          style={{ flexShrink: 0 }}
          data-testid="recent-run-conclusion"
        >
          {STATUS_LABELS[classification.status]}
        </Badge>
        <PipelineBadge pipeline={run.pipeline} />
        <RepoBadge repo={run.repo} />
      </Group>
      <Group gap="xs" wrap="wrap" className="agent-run-meta">
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
          {formatDuration(run.elapsedSeconds)} · finished{' '}
          <RelativeTime iso={run.updatedAt} />
        </Text>
        <Group
          gap={6}
          wrap="nowrap"
          className="agent-run-meta__actions"
          style={{ marginLeft: 'auto', flexShrink: 0 }}
        >
          <Anchor
            href={run.url}
            target="_blank"
            rel="noreferrer"
            size="xs"
            c="dimmed"
          >
            {run.url.startsWith('https://github.com/')
              ? 'View run on GitHub ↗'
              : 'View run'}
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
  variant = 'detail',
  selectHref,
}: {
  session: CliSession;
  variant?: ActivityRowVariant;
  selectHref?: string;
}) {
  const { host, artifacts } = session;
  const label = cliSessionLabel(session);
  const liveViewUrl = sessionLiveViewUrl(session);

  if (variant === 'operations') {
    return (
      <div
        className="operations-row"
        data-testid={`cli-session-${session.sessionId}`}
      >
        <Stack gap={5} style={{ minWidth: 0 }}>
          <RowTitle
            text={label}
            mobileHref={`/sessions/${session.sessionId}`}
            selectHref={selectHref}
          />
          <SessionStatusLine
            status={session.status}
            statusUpdatedAt={session.statusUpdatedAt}
            liveness={session.liveness}
          />
          <Group gap="xs" wrap="wrap">
            <Badge
              variant="filled"
              color={LIVENESS_COLORS[session.liveness]}
              size="xs"
              style={{ flexShrink: 0 }}
              data-testid="cli-session-liveness"
            >
              {LIVENESS_LABELS[session.liveness]}
            </Badge>
            <AgentBadge agent={session.agent} />
            {session.repo && <RepoBadge repo={session.repo} />}
          </Group>
        </Stack>
        <BridgePaneLink
          mobileHref={`/sessions/${session.sessionId}`}
          paneHref={selectHref ?? `/sessions/${session.sessionId}`}
          size="sm"
          className="operations-primary-action"
          data-testid="cli-session-link"
        >
          Open session
        </BridgePaneLink>
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
          size="xs"
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
            GitHub PR #{session.pr.number} ↗
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
        {liveViewUrl && (
          <Anchor
            href={liveViewUrl}
            target="_blank"
            rel="noreferrer"
            size="xs"
            data-testid="cli-session-live-view"
          >
            Open live ↗
          </Anchor>
        )}
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
