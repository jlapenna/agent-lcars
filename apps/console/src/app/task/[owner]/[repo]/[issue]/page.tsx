import { Group, Text } from '@mantine/core';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../../../../auth';
import { getWatchedRepos } from '../../../../../lib/github-client';
import { getTaskDetail } from '../../../../../lib/task-detail';
import { ConsoleAppShell } from '../../../../console-app-shell';
import { ConsoleFooter } from '../../../../console-footer';
import { formatRelativeTime } from '../../../../format';
import { ItemOverflowMenu } from '../../../../item-overflow-menu';
import { NavPageLoading } from '../../../../page-loading';
import { QuickTaskButton } from '../../../../quick-task-button';
import { RefreshButton } from '../../../../refresh-button';
import { LogicalWorkCard } from '../../../logical-work-card';

interface PageProps {
  params: Promise<{ owner: string; repo: string; issue: string }>;
}

/**
 * The stable canonical task link (agent-lcars#306, and the same need
 * agent-lcars#264 describes): `/task/<owner>/<repo>/<issue>` resolves a
 * task directly from GitHub by its own identity, independent of whatever
 * the open-item board currently shows. A task that closes, merges, or
 * otherwise leaves the inbox keeps working here - see `task-detail.ts`'s
 * own doc comment for why this deliberately does not depend on
 * `getCachedActionItems`'s open-item listing.
 */
async function TaskDetailPageContent({ params }: PageProps) {
  const session = await auth();
  assertAdmin(session, '/login');

  const { owner, repo, issue } = await params;
  const issueNumber = Number(issue);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    notFound();
  }

  const detail = await getTaskDetail(owner, repo, issueNumber);

  if (detail.status === 'not-found') {
    notFound();
  }

  // `detail.status === 'ok'` reports the real age of the cached sources it
  // was built from (see `getTaskDetail`'s own doc comment on `generatedAt`)
  // - only the 'error' case (nothing was fetched at all) falls back to the
  // render time.
  const generatedAt =
    detail.status === 'ok' ? detail.generatedAt : new Date().toISOString();
  const title =
    detail.status === 'ok'
      ? `Task #${detail.item.number}`
      : `Task #${issueNumber}`;
  const subtitle =
    detail.status === 'ok'
      ? `${detail.repo.owner}/${detail.repo.name} · ${detail.item.kind === 'pr' ? 'Pull request' : 'Issue'}`
      : `${owner}/${repo}`;

  return (
    <ConsoleAppShell
      current="deck"
      title={title}
      subtitle={subtitle}
      utilities={
        <Group gap="xs" wrap="nowrap">
          <RefreshButton
            generatedAt={generatedAt}
            initialLabel={formatRelativeTime(generatedAt)}
            bustsGithubCache
          />
          {detail.status === 'ok' && detail.item.kind === 'issue' && (
            <ItemOverflowMenu item={detail.item} />
          )}
        </Group>
      }
      footer={
        <ConsoleFooter
          actions={
            <QuickTaskButton
              watchedRepos={getWatchedRepos()}
              initialRepoKey={
                detail.status === 'ok'
                  ? `${detail.repo.owner}/${detail.repo.name}`
                  : undefined
              }
              sourceIdentities={
                detail.status === 'ok'
                  ? [
                      {
                        label:
                          detail.item.kind === 'pr' ? 'Pull request' : 'Task',
                        value: `${detail.repo.owner}/${detail.repo.name}#${detail.item.number}`,
                      },
                    ]
                  : []
              }
            />
          }
        />
      }
    >
      {detail.status === 'error' && (
        <Text size="sm" c="orange" mb="md" data-testid="task-detail-error">
          {detail.warning}
        </Text>
      )}

      {detail.status === 'ok' && (
        <LogicalWorkCard
          work={detail.work}
          runs={detail.runs}
          anchorState={detail.anchorState}
        />
      )}
    </ConsoleAppShell>
  );
}

// `cacheComponents` requires uncached data access to sit inside a Suspense
// boundary, same as /sessions/[id] - see that page's identical comment.
export default function TaskDetailPage({ params }: PageProps) {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="deck"
          title="Task detail"
          className="deck-page-shell"
          rows={4}
        />
      }
    >
      <TaskDetailPageContent params={params} />
    </Suspense>
  );
}
