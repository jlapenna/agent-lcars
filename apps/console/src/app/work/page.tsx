import {
  Anchor,
  Button,
  Group,
  NativeSelect,
  Text,
  TextInput,
} from '@mantine/core';
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
import {
  parseWorkListQuery,
  WORK_PAGE_LIMIT,
  workListHref,
  type WorkListParams,
} from './work-list-query';
import { WorkWorkspace } from './work-workspace';

/**
 * Unlike every other console destination, this page is not admin-gated -
 * `WorkPageShell` below only checks that a session exists. `listItems`
 * itself still requires the `work.operator` grant (see `work-router.ts`'s
 * `operator` middleware); a signed-in user without one gets a 401 tuple
 * back, rendered here as a plain "no grant" message instead of the table.
 */
async function WorkBody({ query }: { query: WorkListParams }) {
  let input;
  try {
    input = parseWorkListQuery(query);
  } catch {
    return (
      <Text role="alert">
        Invalid Work filters or cursor.{' '}
        <Anchor href="/work">Reset filters</Anchor>
      </Text>
    );
  }
  const [err, data] = await listItems(input);
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
        {data.items.length === 0 ? (
          <Text c="dimmed" size="sm">
            No matching work items on this page.
          </Text>
        ) : (
          <WorkList items={data.items} />
        )}
        <Text size="xs" c="dimmed">
          Each page examines up to {WORK_PAGE_LIMIT} native tasks. Filters apply
          within each page; an empty page may have older matches.
        </Text>
        <Group mt="sm" wrap="wrap">
          {input.cursor && (
            <Anchor href={workListHref({ ...query, cursor: undefined })}>
              First work page
            </Anchor>
          )}
          {data.nextCursor && (
            <Anchor href={workListHref({ ...query, cursor: data.nextCursor })}>
              Next work page →
            </Anchor>
          )}
        </Group>
      </div>
    </>
  );
}

function WorkViewContent({
  query,
  watchedRepos,
  canCreateWork,
}: WorkViewProps) {
  return (
    <WorkWorkspace
      toolbar={
        <>
          <Anchor href="/work/schedules" size="sm">
            Schedules →
          </Anchor>
          {canCreateWork && (
            <form action="/work" className="work-list-filters">
              <Group align="end" wrap="wrap" gap="xs">
                <NativeSelect
                  label="State"
                  name="state"
                  defaultValue={query.state ?? ''}
                  data={[
                    '',
                    'running',
                    'done',
                    'parked',
                    'failed',
                    'canceled',
                  ].map((value) => ({ value, label: value || 'All states' }))}
                />
                <NativeSelect
                  label="Repository"
                  name="repo"
                  defaultValue={query.repo ?? ''}
                  data={[
                    { value: '', label: 'All repositories' },
                    ...watchedRepos.map((repo) => ({
                      value: `${repo.owner}/${repo.name}`,
                      label: `${repo.owner}/${repo.name}`,
                    })),
                  ]}
                  style={{ flex: '1 1 180px', minWidth: 0 }}
                />
                <TextInput
                  label="Principal"
                  name="principal"
                  defaultValue={query.principal ?? ''}
                  maxLength={128}
                  placeholder="All principals"
                  style={{ flex: '1 1 180px', minWidth: 0 }}
                />
                <Button type="submit" size="sm">
                  Apply filters
                </Button>
                <Anchor href="/work" size="sm">
                  Clear filters
                </Anchor>
              </Group>
            </form>
          )}
        </>
      }
    >
      <Suspense
        key={JSON.stringify(query)}
        fallback={<PageLoading rows={4} header={false} />}
      >
        <WorkBody query={query} />
      </Suspense>
    </WorkWorkspace>
  );
}

interface WorkViewProps {
  query: WorkListParams;
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

async function WorkPageShell({
  searchParams,
}: {
  searchParams: Promise<WorkListParams>;
}) {
  const session = await auth();
  if (!session) redirect('/login');
  const watchedRepos = getWatchedRepos();

  return (
    <WorkView
      query={await searchParams}
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
export default function WorkPage({
  searchParams,
}: {
  searchParams: Promise<WorkListParams>;
}) {
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
      <WorkPageShell searchParams={searchParams} />
    </Suspense>
  );
}
