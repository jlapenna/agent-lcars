import type { ItemView } from '@agent-lcars/work/derive';
import {
  Anchor,
  Badge,
  Code,
  Group,
  Stack,
  Table,
  TableTbody,
  TableTd,
  TableTh,
  TableThead,
  TableTr,
  Text,
  Title,
} from '@mantine/core';
import { notFound, redirect } from 'next/navigation';
import { Suspense } from 'react';

import { auth } from '@/auth';

import { formatRelativeTime } from '../../format';
import { NavPageLoading } from '../../page-loading';
import { withConsolePageShell } from '../../with-console-page-shell';
import { cancelItem, getItem, redispatchItem } from '../actions';
import { safeHttpUrl } from '../safe-url';
import { WorkActions } from '../work-actions';

interface PageProps {
  params: Promise<{ id: string }>;
}

const STATE_COLORS: Record<ItemView['state'], string> = {
  parked: 'yellow',
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
                <Text size="xs">{run.executor ?? 'github-actions'}</Text>
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
            <Badge size="xs" variant="outline" color="cyan">
              pinned
            </Badge>
          )}
        </Group>
      ))}
    </Stack>
  );
}

/** Discriminated on `status` rather than an optional `item`/`message` pair,
 *  so the content component below narrows cleanly without a cast. */
type WorkDetail =
  { status: 'ok'; item: ItemView } | { status: 'error'; message: string };

interface WorkDetailViewProps {
  detail: WorkDetail;
  title: string;
  subtitle: string;
}

function WorkDetailViewContent({ detail }: WorkDetailViewProps) {
  if (detail.status === 'error') {
    return (
      <Text c="dimmed" size="sm">
        {detail.message}
      </Text>
    );
  }

  const { item } = detail;

  // Offer resume from the latest session of the item's latest run - `runs`
  // is sorted oldest-first (see `toItemView`), so `.at(-1)` is the latest.
  const latestRunView = item.runs.at(-1);
  const resumeCandidate = latestRunView
    ? [...item.sessions]
        .filter((s) => s.runId === latestRunView.runId)
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0]
    : undefined;
  const pinned = item.state === 'running' || item.state === 'parked';

  return (
    <Stack gap="md">
      <Group gap="xs">
        <Badge color={STATE_COLORS[item.state]} size="lg">
          {item.state}
        </Badge>
        <Text size="sm" c="dimmed">
          {item.spec.target.repo} &middot; {item.spec.pipeline}
        </Text>
      </Group>
      <Text size="sm" c="dimmed">
        Requested by {item.origin.principal} via {item.origin.channel}
      </Text>
      <Code block>{item.spec.description}</Code>
      <WorkActions
        id={item.id}
        state={item.state}
        cancel={cancelItem}
        redispatch={redispatchItem}
        {...(resumeCandidate && {
          resumeCandidate: {
            sessionId: resumeCandidate.sessionId,
            ...(resumeCandidate.title !== undefined && {
              title: resumeCandidate.title,
            }),
          },
        })}
      />
      <Stack gap="xs">
        <Title order={2} size="h4">
          Runs
        </Title>
        <RunsTable runs={item.runs} />
      </Stack>
      <Stack gap="xs">
        <Title order={2} size="h4">
          Sessions
        </Title>
        <SessionsList sessions={item.sessions} pinned={pinned} />
      </Stack>
    </Stack>
  );
}

const WorkDetailView = withConsolePageShell(
  WorkDetailViewContent,
  ({ title, subtitle }: WorkDetailViewProps) => ({
    className: 'work-page-shell',
    current: 'work',
    title,
    subtitle,
  }),
);

async function WorkDetailPageContent({ params }: PageProps) {
  const session = await auth();
  if (!session) redirect('/login');

  const { id } = await params;
  const [err, item] = await getItem({ id });

  if (err?.code === 'NOT_FOUND') {
    notFound();
  }

  // `item` is only `undefined` in the error branch below - the tuple's two
  // shapes (`[null, ItemView]` / `[error, undefined]`) are correlated by
  // construction (see `@orpc/next`'s `ServerFunctionResult`), just not by a
  // TypeScript-visible discriminant once destructured into two bindings.
  const detail: WorkDetail = err
    ? {
        status: 'error',
        message:
          err.code === 'UNAUTHORIZED'
            ? 'Your GitHub login has no work grant.'
            : `Could not load this work item: ${err.message}`,
      }
    : { status: 'ok', item: item as ItemView };

  const title = detail.status === 'ok' ? detail.item.spec.title : 'Work item';
  const subtitle =
    detail.status === 'ok'
      ? `Work item · ${id} · updated ${formatRelativeTime(detail.item.updatedAt)}`
      : `Work item · ${id}`;

  return <WorkDetailView detail={detail} title={title} subtitle={subtitle} />;
}

export default function WorkDetailPage({ params }: PageProps) {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="work"
          title="Work item"
          className="work-page-shell"
          rows={4}
        />
      }
    >
      <WorkDetailPageContent params={params} />
    </Suspense>
  );
}
