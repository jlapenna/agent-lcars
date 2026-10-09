import { type ItemView, latestRun } from '@agent-lcars/work/derive';
import { Stack, Text } from '@mantine/core';
import { notFound, redirect } from 'next/navigation';
import { Suspense } from 'react';

import { auth } from '@/auth';
import { getWatchedRepos } from '@/lib/github-client';
import { resolvePrincipal, workGrants } from '@/lib/work-grants';

import { ConsoleCommandUtilities } from '../../console-command-utilities';
import { formatRelativeTime } from '../../format';
import { NavPageLoading } from '../../page-loading';
import { TaskDetailHistory } from '../../task/task-detail-history';
import { withConsolePageShell } from '../../with-console-page-shell';
import {
  cancelItem,
  getItem,
  redispatchItem,
  replyToWorkItem,
  updateItem,
} from '../actions';
import { EditWork } from '../edit-work';
import { WorkActions } from '../work-actions';

interface PageProps {
  params: Promise<{ id: string }>;
}

/** Discriminated on `status` rather than an optional `item`/`message` pair,
 *  so the content component below narrows cleanly without a cast. */
type WorkDetail =
  { status: 'ok'; item: ItemView } | { status: 'error'; message: string };

/** The body only needs the resolved item; the two command-rail props belong
 *  to the header shell, keeping the exported content component testable
 *  without an auth principal. */
interface WorkDetailContentProps {
  isAdmin?: boolean;
  detail: WorkDetail;
  title: string;
  subtitle: string;
}

interface WorkDetailViewProps extends WorkDetailContentProps {
  watchedRepos: ReturnType<typeof getWatchedRepos>;
  canCreateWork: boolean;
  isAdmin: boolean;
}

export function WorkDetailViewContent({
  detail,
  isAdmin = false,
}: WorkDetailContentProps) {
  if (detail.status === 'error') {
    return (
      <Text c="dimmed" size="sm">
        {detail.message}
      </Text>
    );
  }

  const { item } = detail;

  return (
    <Stack gap="md">
      <EditWork
        id={item.id}
        title={item.spec.title}
        description={item.spec.description}
        running={item.state === 'running'}
        update={updateItem}
      />
      <TaskDetailHistory
        anchor={{ workId: item.id }}
        item={item}
        canViewSessions={isAdmin}
        actions={
          <WorkActions
            id={item.id}
            latestRunId={latestRun(item.runs)?.runId}
            state={item.state}
            cancel={cancelItem}
            redispatch={redispatchItem}
            reply={replyToWorkItem}
          />
        }
      />
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
      isAdmin={session.user?.isAdmin === true}
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
