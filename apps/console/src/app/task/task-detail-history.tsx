import type { TaskId } from '@agent-lcars/orchestrator';
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
  Title,
} from '@mantine/core';
import type { ReactNode } from 'react';

import { Conversation } from '../work/conversation';
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
        ref
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
            <TableTr key={run.runId}>
              <TableTd>{run.runId}</TableTd>
              <TableTd>{run.state}</TableTd>
              <TableTd>
                <Stack gap={0}>
                  <Text size="xs">Queue executor</Text>
                  {run.queue?.state === 'claimed' && run.queue.claimedBy && (
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
                <RunRef value={run.result?.ref} />
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
}: {
  sessions: ItemView['sessions'];
  pinned: boolean;
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
          <Anchor
            href={`/sessions/${encodeURIComponent(session.sessionId)}`}
            size="sm"
          >
            {session.title ?? session.sessionId}
            {session.status ? ` · ${session.status}` : ''}
          </Anchor>
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
}: {
  anchor: TaskId;
  item: ItemView;
  revision?: number;
  actions?: ReactNode;
  audit?: ReactNode;
}) {
  const native = 'workId' in anchor;
  const deliverables = item.runs.filter((run) => run.result?.ref);
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
          {item.spec.target.repo} · {item.spec.pipeline}
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
      <Stack gap="xs">
        <Title order={2} size="h4">
          Conversation
        </Title>
        {item.runs.length === 0 ? (
          <Text size="sm" c="dimmed">
            No conversation yet.
          </Text>
        ) : (
          <Conversation item={item} />
        )}
      </Stack>
      {actions}
      <Stack gap="xs">
        <Title order={2} size="h4">
          Runs
        </Title>
        <RunsTable runs={item.runs} />
        {audit}
      </Stack>
      <Stack gap="xs">
        <Title order={2} size="h4">
          Sessions
        </Title>
        <SessionsList
          sessions={item.sessions}
          pinned={
            item.state === 'running' ||
            item.state === 'parked' ||
            item.state === 'failed'
          }
        />
      </Stack>
      <Stack gap="xs" data-testid="task-deliverables">
        <Title order={2} size="h4">
          Deliverables
        </Title>
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
              {safeHttpUrl(run.result?.ref) ? (
                <Anchor
                  href={safeHttpUrl(run.result?.ref)}
                  target="_blank"
                  rel="noreferrer"
                  size="sm"
                >
                  {run.result?.ref}
                </Anchor>
              ) : (
                <Text size="sm">{run.result?.ref}</Text>
              )}
            </Group>
          ))
        )}
      </Stack>
    </Stack>
  );
}
