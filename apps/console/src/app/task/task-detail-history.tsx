import type { TaskId } from '@agent-lcars/orchestrator';
import { workRepository } from '@agent-lcars/work';
import type { ItemView } from '@agent-lcars/work/derive';
import {
  Anchor,
  Badge,
  Group,
  Stack,
  Table,
  TableScrollContainer,
  TableTbody,
  TableTd,
  TableTh,
  TableThead,
  TableTr,
  Text,
} from '@mantine/core';
import type { ReactNode } from 'react';

import { ExecutionStatus } from '../execution-status';
import { OpsPanel } from '../ops-primitives';
import { Conversation } from '../work/conversation';
import { WorkSourceEvents } from '../work/event-work-activity';
import { resultRefs } from '../work/result-refs';
import { safeHttpUrl } from '../work/safe-url';

const STATE_COLORS: Record<ItemView['state'], string> = {
  parked: 'yellow',
  failed: 'red',
  running: 'blue',
  done: 'green',
  canceled: 'gray',
};

/** `run.result.ref` is agent-reported and opaque (see `model.ts`'s
 *  `runResultSchema`); render it as a link only once `safeHttpUrl` confirms
 *  it is an absolute http(s) URL, otherwise as inert text. */
function RunRef({ value }: { value: string | undefined }) {
  const href = safeHttpUrl(value);
  if (href) {
    return (
      <Anchor href={href} target="_blank" rel="noreferrer" size="xs">
        {new URL(href).hostname === 'github.com' ? 'GitHub ref ↗' : 'ref'}
      </Anchor>
    );
  }
  if (value) {
    return (
      <Text size="xs" c="dimmed">
        {value}
      </Text>
    );
  }
  return null;
}

export function RunsTable({ runs }: { runs: ItemView['runs'] }) {
  if (runs.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No runs yet.
      </Text>
    );
  }
  return (
    <TableScrollContainer minWidth={560} className="work-runs-table-scroll">
      <Table verticalSpacing="xs" fz="sm">
        <TableThead>
          <TableTr>
            <TableTh>Run</TableTh>
            <TableTh>State</TableTh>
            <TableTh>Executor</TableTh>
            <TableTh>Result</TableTh>
            <TableTh>Summary</TableTh>
            <TableTh>Ref</TableTh>
          </TableTr>
        </TableThead>
        <TableTbody>
          {runs.map((run) => (
            <TableTr key={run.runId} id={`run-${run.runId}`}>
              <TableTd>
                {run.runId}
                {run.sourceRevision && (
                  <details>
                    <summary>
                      Input revision · attempt {run.revisionAttempt}
                    </summary>
                    <Text size="xs">{run.sourceRevision.key}</Text>
                    <pre
                      style={{
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {JSON.stringify(run.sourceRevision.input, null, 2)}
                    </pre>
                  </details>
                )}
              </TableTd>
              <TableTd>
                {run.state}
                <ExecutionStatus run={run} />
                {run.triagePublication && (
                  <Text size="xs">
                    Triage updates: {run.triagePublication.state}
                    {run.triagePublication.error &&
                      ` — ${run.triagePublication.error}`}
                  </Text>
                )}
              </TableTd>
              <TableTd>
                <Stack gap={0}>
                  <Text size="xs">
                    {['inbox-summary', 'handoff-summary'].includes(run.pipeline)
                      ? 'Model call'
                      : 'Queue executor'}{' '}
                    · {run.pipeline}
                  </Text>
                  {run.queue?.state !== 'queued' && run.queue?.claimedBy && (
                    <Text size="xs" c="dimmed">
                      claimed by {run.queue.claimedBy}
                    </Text>
                  )}
                </Stack>
              </TableTd>
              <TableTd>
                {run.result && (
                  <Badge
                    variant="light"
                    size="xs"
                    color={run.result.ok ? 'green' : 'red'}
                  >
                    {run.result.ok ? 'ok' : 'not ok'}
                  </Badge>
                )}
              </TableTd>
              <TableTd>{run.result?.summary}</TableTd>
              <TableTd>
                {resultRefs(run.result).map((value) => (
                  <RunRef key={value} value={value} />
                ))}
              </TableTd>
            </TableTr>
          ))}
        </TableTbody>
      </Table>
    </TableScrollContainer>
  );
}

/** `pinned` reflects whether the item that owns these sessions is still
 *  open (`running`/`parked`) - derived from state already on hand, not a
 *  new fetch. */
export function SessionsList({
  sessions,
  pinned,
  canViewSessions = true,
}: {
  sessions: ItemView['sessions'];
  pinned: boolean;
  canViewSessions?: boolean;
}) {
  if (sessions.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No sessions yet.
      </Text>
    );
  }
  return (
    <Stack gap={4}>
      {sessions.map((session) => (
        <Group key={session.sessionId} gap="xs">
          {canViewSessions ? (
            <Anchor
              href={`/sessions/${encodeURIComponent(session.sessionId)}`}
              size="sm"
            >
              {session.title ?? session.sessionId}
              {session.status ? ` · ${session.status}` : ''}
            </Anchor>
          ) : (
            <Text size="sm">
              {session.title ?? session.sessionId}
              {session.status ? ` · ${session.status}` : ''}
            </Text>
          )}
          {pinned && (
            <Badge size="xs" variant="outline" color="teal">
              pinned
            </Badge>
          )}
        </Group>
      ))}
    </Stack>
  );
}

/** Common audit surface; the typed anchor is presentation metadata only.
 * Mutation controls are supplied by each authorized route, never inferred
 * from ItemView.id (which may be a GitHub task key rather than a work id). */
export function TaskDetailHistory({
  anchor,
  item,
  revision,
  actions,
  audit,
  canViewSessions = true,
}: {
  anchor: TaskId;
  item: ItemView;
  revision?: number;
  actions?: ReactNode;
  audit?: ReactNode;
  canViewSessions?: boolean;
}) {
  const native = 'workId' in anchor;
  const effectivePipeline =
    item.providerRouting?.acceptedGeneration?.pipeline ??
    item.providerRouting?.effectivePipeline ??
    item.spec.pipeline;
  const deliverables = item.runs.filter(
    (run) => resultRefs(run.result).length > 0,
  );
  return (
    <Stack
      gap="md"
      data-testid="task-detail-history"
      style={{ minWidth: 0, overflowWrap: 'anywhere' }}
    >
      <Group gap="xs" wrap="wrap" data-testid="task-detail-provenance">
        <Badge color={STATE_COLORS[item.state]} size="lg">
          {item.state}
        </Badge>
        <Text size="sm" c="dimmed">
          {workRepository(item.spec)} · effective provider {effectivePipeline}
        </Text>
        <Text size="xs" c="dimmed">
          {native ? 'Native work' : `GitHub · ${anchor.repo}#${anchor.issue}`} ·{' '}
          {item.origin.principal} via {item.origin.channel}
        </Text>
        {revision !== undefined && (
          <Text
            size="xs"
            c="dimmed"
          >{`authoritative state rev ${revision}`}</Text>
        )}
      </Group>
      {item.providerRouting !== undefined && (
        <Text size="sm" role="status">
          Requested provider {item.providerRouting.requestedPipeline} ·
          effective provider {effectivePipeline} · handoff{' '}
          {item.providerRouting.status}
          {item.providerRouting.reason
            ? ` (${item.providerRouting.reason})`
            : ''}
          {' · requested by '}
          {item.providerRouting.actor}
          {' at '}
          <time dateTime={item.providerRouting.requestedAt}>
            {item.providerRouting.requestedAt}
          </time>
          {item.providerRouting.status === 'refused' &&
            (item.providerRouting.reason === 'run-newer-than-label'
              ? ' · Reapply the intended label to confirm this change for the current work.'
              : item.providerRouting.reason === 'unauthorized-provider-switch'
                ? ' · An administrator must request this provider change.'
                : ' · Reapply the intended label after ownership settles and physical retirement completes.')}
        </Text>
      )}
      <WorkSourceEvents item={item} />
      <OpsPanel title="Conversation">
        {item.runs.length === 0 ? (
          <Text size="sm" c="dimmed">
            No conversation yet.
          </Text>
        ) : (
          <Conversation item={item} canViewSessions={canViewSessions} />
        )}
      </OpsPanel>
      {actions}
      <OpsPanel title="Runs" count={item.runs.length}>
        <RunsTable runs={item.runs} />
        {audit}
      </OpsPanel>
      <OpsPanel title="Sessions" count={item.sessions.length}>
        <SessionsList
          sessions={item.sessions}
          canViewSessions={canViewSessions}
          pinned={
            item.state === 'running' ||
            item.state === 'parked' ||
            item.state === 'failed'
          }
        />
      </OpsPanel>
      <OpsPanel
        title="Deliverables"
        count={deliverables.length}
        data-testid="task-deliverables"
      >
        {deliverables.length === 0 ? (
          <Text size="sm" c="dimmed">
            No deliverables yet.
          </Text>
        ) : (
          deliverables.map((run) => (
            <Group key={run.runId} gap="xs" wrap="wrap">
              <Text size="xs" c="dimmed">
                {run.runId}
              </Text>
              {resultRefs(run.result).map((ref) =>
                safeHttpUrl(ref) ? (
                  <Anchor
                    key={ref}
                    href={safeHttpUrl(ref)}
                    target="_blank"
                    rel="noreferrer"
                    size="sm"
                  >
                    {ref}
                  </Anchor>
                ) : (
                  <Text key={ref} size="sm">
                    {ref}
                  </Text>
                ),
              )}
            </Group>
          ))
        )}
      </OpsPanel>
    </Stack>
  );
}
