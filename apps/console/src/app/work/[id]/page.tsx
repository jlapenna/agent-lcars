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
import { notFound, redirect } from 'next/navigation';
import { Suspense } from 'react';

import { auth } from '@/auth';
import { getWatchedRepos } from '@/lib/github-client';
import { resolvePrincipal, workGrants } from '@/lib/work-grants';

import { ConsoleCommandUtilities } from '../../console-command-utilities';
import { formatRelativeTime } from '../../format';
import { NavPageLoading } from '../../page-loading';
import { withConsolePageShell } from '../../with-console-page-shell';
import {
  cancelItem,
  getItem,
  redispatchItem,
  replyToWorkItem,
} from '../actions';
import { Conversation } from '../conversation';
import { safeHttpUrl } from '../safe-url';
import { WorkActions } from '../work-actions';

interface PageProps {
  params: Promise<{ id: string }>;
}

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

/** Discriminated on `status` rather than an optional `item`/`message` pair,
 *  so the content component below narrows cleanly without a cast. */
type WorkDetail =
  { status: 'ok'; item: ItemView } | { status: 'error'; message: string };

/** The body only needs the resolved item; the two command-rail props belong
 *  to the header shell, keeping the exported content component testable
 *  without an auth principal. */
interface WorkDetailContentProps {
  detail: WorkDetail;
  title: string;
  subtitle: string;
}

interface WorkDetailViewProps extends WorkDetailContentProps {
  watchedRepos: ReturnType<typeof getWatchedRepos>;
  canCreateWork: boolean;
}

export function WorkDetailViewContent({ detail }: WorkDetailContentProps) {
  if (detail.status === 'error') {
    return (
      <Text c="dimmed" size="sm">
        {detail.message}
      </Text>
    );
  }

  const { item } = detail;
  const pinned =
    item.state === 'running' ||
    item.state === 'parked' ||
    item.state === 'failed';

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
      <Conversation item={item} />
      <WorkActions
        id={item.id}
        state={item.state}
        cancel={cancelItem}
        redispatch={redispatchItem}
        reply={replyToWorkItem}
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
  ({ title, subtitle, watchedRepos, canCreateWork }: WorkDetailViewProps) => ({
    className: 'work-page-shell',
    current: 'work',
    title,
    subtitle,
    utilities: (
      <>
        <div className="work-detail-utilities work-detail-utilities--desktop console-utilities--desktop">
          <ConsoleCommandUtilities
            watchedRepos={watchedRepos}
            includeQuickTask={canCreateWork}
          />
        </div>
        <div className="work-detail-utilities work-detail-utilities--mobile console-utilities--mobile">
          <ConsoleCommandUtilities
            watchedRepos={watchedRepos}
            includeNavigation
            includeQuickTask={canCreateWork}
          />
        </div>
      </>
    ),
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

  // Like `/work` itself, this route admits signed-in users without a
  // work.operator grant, so creation is only offered when the principal
  // actually holds it (same resolution as work/page.tsx).
  return (
    <WorkDetailView
      detail={detail}
      title={title}
      subtitle={subtitle}
      watchedRepos={getWatchedRepos()}
      canCreateWork={
        session.user?.login !== undefined &&
        resolvePrincipal(
          `github:${session.user.login}`,
          workGrants(),
        )?.scopes.includes('work.operator') === true
      }
    />
  );
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
