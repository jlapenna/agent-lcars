import { Anchor, Text } from '@mantine/core';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { auth } from '@/auth';
import { getWatchedRepos } from '@/lib/github-client';
import { resolvePrincipal, workGrants } from '@/lib/work-grants';

import { ConsoleCommandUtilities } from '../console-command-utilities';
import { NavPageLoading, PageLoading } from '../page-loading';
import { withConsolePageShell } from '../with-console-page-shell';
import { listItems } from './actions';
import { WorkList } from './work-list';
import { WorkWorkspace } from './work-workspace';

/**
 * Unlike every other console destination, this page is not admin-gated -
 * `WorkPageShell` below only checks that a session exists. `listItems`
 * itself still requires the `work.operator` grant (see `work-router.ts`'s
 * `operator` middleware); a signed-in user without one gets a 401 tuple
 * back, rendered here as a plain "no grant" message instead of the table.
 */
async function WorkBody() {
  const [err, data] = await listItems({ limit: 200 });
  if (err) {
    return (
      <div className="work-workspace__empty">
        <Text c="dimmed" size="sm">
          {err.code === 'UNAUTHORIZED'
            ? 'Your GitHub login has no work grant.'
            : `Could not load work items: ${err.message}`}
        </Text>
      </div>
    );
  }
  return (
    <>
      <div className="console-workspace__section work-workspace__list">
        <WorkList items={data.items} />
      </div>
    </>
  );
}

function WorkViewContent() {
  return (
    <WorkWorkspace
      toolbar={
        <Anchor href="/work/schedules" size="sm">
          Schedules →
        </Anchor>
      }
    >
      <Suspense fallback={<PageLoading rows={4} header={false} />}>
        <WorkBody />
      </Suspense>
    </WorkWorkspace>
  );
}

interface WorkViewProps {
  watchedRepos: ReturnType<typeof getWatchedRepos>;
  canCreateWork: boolean;
}

const WorkView = withConsolePageShell(
  WorkViewContent,
  ({ watchedRepos, canCreateWork }: WorkViewProps) => ({
    className: 'work-page-shell',
    current: 'work',
    title: 'Work',
    subtitle: 'Native work items',
    // Work was the one destination with no utility cluster at all, so create
    // and refresh were unreachable from it and the mobile overflow menu
    // - the only way to reach the other destinations on a phone - was too
    // (#1810).
    utilities: (
      <>
        <div className="work-utilities work-utilities--desktop console-utilities--desktop">
          <ConsoleCommandUtilities
            watchedRepos={watchedRepos}
            includeQuickTask={canCreateWork}
          />
        </div>
        <div className="work-utilities work-utilities--mobile console-utilities--mobile">
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

async function WorkPageShell() {
  const session = await auth();
  if (!session) redirect('/login');
  const watchedRepos = getWatchedRepos();

  return (
    <WorkView
      watchedRepos={watchedRepos}
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

// Same streaming shape as every other console destination (see
// shuttlebay/page.tsx): the header renders immediately behind
// `NavPageLoading` while `auth()` and the items list resolve.
export default function WorkPage() {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="work"
          title="Work"
          className="work-page-shell"
          rows={4}
        />
      }
    >
      <WorkPageShell />
    </Suspense>
  );
}
