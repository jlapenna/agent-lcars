import type { Run, RunEvent, RunState } from '@agent-lcars/orchestrator';
import { isLive } from '@agent-lcars/orchestrator';
import { Anchor, Badge, Divider, Group, Stack, Text } from '@mantine/core';

import type { AgentPipeline } from '../../lib/agent-activity';
import { PipelineBadge } from '../agent-activity-panel';
import { RelativeTime } from '../relative-time';

const RUN_STATE_LABELS: Record<RunState, string> = {
  pending: 'pending',
  running: 'running',
  finished: 'finished',
  canceled: 'canceled',
  lost: 'lost',
};

const RUN_STATE_COLORS: Record<RunState, string> = {
  pending: 'gray',
  running: 'blue',
  finished: 'green',
  canceled: 'yellow',
  lost: 'red',
};

/** Who caused a run event, in reader-facing terms - mirrors
 * `libs/orchestrator/src/model.ts`'s own `runEventSchema.by` doc comment. */
const EVENT_BY_LABELS: Record<RunEvent['by'], string> = {
  request: 'requested',
  dispatch: 'dispatched',
  report: 'reported',
  operator: 'operator',
  expiry: 'lease expired',
};

const KNOWN_PIPELINES = new Set<AgentPipeline>(['claude', 'codex', 'opencode']);

function isKnownPipeline(pipeline: string): pipeline is AgentPipeline {
  return KNOWN_PIPELINES.has(pipeline as AgentPipeline);
}

/** A finished-but-unsuccessful run reads as "failed", the one place this
 * view diverges from a flat `RUN_STATE_LABELS` lookup - matching
 * `attemptStatusBadge`'s equivalent "distinguish a failed completed run"
 * behavior in logical-work-card.tsx for the legacy attempts list. */
function runStateBadge(run: Run): { label: string; color: string } {
  if (run.state === 'finished' && run.result && !run.result.ok) {
    return { label: 'failed', color: 'red' };
  }
  return {
    label: RUN_STATE_LABELS[run.state],
    color: RUN_STATE_COLORS[run.state],
  };
}

/** Pulls the trailing generation number back out of a run's own
 * `{repo}#{issue}/r{generation}` id (see `libs/orchestrator/src/decide.ts`'s
 * `requestRun`) for a `g<N>` badge consistent with the legacy attempts
 * list's own vocabulary (task-detail.ts's `generationFromRunId`, kept
 * separate rather than imported so this component stays self-contained and
 * testable without dragging in that server-only module's transitive
 * imports). */
function generationFromRunId(runId: string): number | undefined {
  const match = /\/r(\d+)$/u.exec(runId);
  return match ? Number(match[1]) : undefined;
}

function RunPipelineBadge({ pipeline }: { pipeline: string }) {
  if (isKnownPipeline(pipeline)) return <PipelineBadge pipeline={pipeline} />;
  return (
    <Badge variant="outline" color="gray" size="xs">
      {pipeline}
    </Badge>
  );
}

function RunParamChips({ params }: { params: Run['params'] }) {
  const entries = Object.entries(params ?? {});
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(([key, value]) => (
        <Badge key={key} variant="outline" color="gray" size="xs">
          {key}: {value.length > 60 ? `${value.slice(0, 60)}…` : value}
        </Badge>
      ))}
    </>
  );
}

function RunEventRow({ event }: { event: RunEvent }) {
  return (
    <Group gap={6} wrap="wrap">
      <Text size="xs" c="dimmed">
        <RelativeTime iso={event.at} variant="compact" />
      </Text>
      <Text size="xs" fw={600}>
        {RUN_STATE_LABELS[event.to]}
      </Text>
      <Text size="xs" c="dimmed">
        ({EVENT_BY_LABELS[event.by]})
      </Text>
      {event.note && (
        <Text size="xs" c="dimmed">
          {event.note}
        </Text>
      )}
    </Group>
  );
}

function RunResultView({ result }: { result: Run['result'] }) {
  if (!result) return null;
  return (
    <Group gap={6} wrap="wrap" data-testid="run-result">
      <Badge variant="filled" color={result.ok ? 'green' : 'red'} size="xs">
        {result.ok ? 'ok' : 'not ok'}
      </Badge>
      {result.summary && (
        <Text size="xs" style={{ whiteSpace: 'pre-wrap' }}>
          {result.summary}
        </Text>
      )}
      {result.ref &&
        (result.ref.startsWith('http') ? (
          <Anchor href={result.ref} target="_blank" rel="noreferrer" size="xs">
            {result.ref}
          </Anchor>
        ) : (
          <Text size="xs" c="dimmed">
            {result.ref}
          </Text>
        ))}
    </Group>
  );
}

/**
 * One run, rendered from the orchestrator's own truth rather than mapped
 * through the legacy attempts overlay (#1015). `LogicalWorkCard` renders
 * this in place of the "Execution attempts" list whenever the task has any
 * orchestrator run history at all - see its own doc comment for the
 * pre-cutover fallback.
 */
function RunRow({ run }: { run: Run }) {
  const badge = runStateBadge(run);
  const generation = generationFromRunId(run.runId);
  return (
    <Stack gap={6} data-testid={`run-${run.runId}`}>
      <Group gap="xs" wrap="wrap">
        <Badge
          variant="filled"
          color={badge.color}
          size="xs"
          data-testid="run-state"
        >
          {badge.label}
        </Badge>
        <RunPipelineBadge pipeline={run.pipeline} />
        {generation !== undefined && (
          <Badge variant="outline" color="gray" size="xs">
            g{generation}
          </Badge>
        )}
        <Text size="xs" c="dimmed">
          started <RelativeTime iso={run.createdAt} />
        </Text>
        {isLive(run.state) && (
          <Text size="xs" c="dimmed">
            lease expires <RelativeTime iso={run.leaseExpiresAt} />
          </Text>
        )}
        <RunParamChips params={run.params} />
      </Group>
      {run.events.length > 0 && (
        <Stack gap={2} pl="xs" data-testid={`run-events-${run.runId}`}>
          {run.events.map((event, index) => (
            <RunEventRow key={index} event={event} />
          ))}
        </Stack>
      )}
      <RunResultView result={run.result} />
    </Stack>
  );
}

/**
 * The task's whole orchestrator run history, newest first - the native
 * replacement (#1015) for task-detail.ts's old attempts-only mapping
 * through `LogicalWork`. Every run's own lifecycle (`events`), lease, and
 * result renders directly from `@agent-lcars/orchestrator`'s `Run` model
 * (libs/orchestrator/src/model.ts) instead of a lossy re-derivation.
 */
export function RunsSection({ runs }: { runs: Run[] }) {
  const sorted = [...runs].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  return (
    <Stack gap={10} data-testid="runs-section">
      <Text size="sm" fw={600}>
        Runs ({runs.length})
      </Text>
      {sorted.map((run, index) => (
        <Stack key={run.runId} gap={10}>
          {index > 0 && <Divider />}
          <RunRow run={run} />
        </Stack>
      ))}
    </Stack>
  );
}
