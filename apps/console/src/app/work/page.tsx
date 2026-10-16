import { PIPELINES } from '@agent-lcars/work';
import { Anchor, Group, Text } from '@mantine/core';
import { redirect } from 'next/navigation';
import { cache, Suspense } from 'react';

import { auth } from '@/auth';
import { getWatchedRepos } from '@/lib/github-client';
import { resolvePrincipal, workGrants } from '@/lib/work-grants';

import { ConsoleCommandUtilities } from '../console-command-utilities';
import {
  ConsoleToolbar,
  ToolbarSearch,
  ToolbarSelect,
  ToolbarWindow,
} from '../console-toolbar';
import { NavPageLoading, PageLoading } from '../page-loading';
import { QuickTaskButton } from '../quick-task-button';
import { withConsolePageShell } from '../with-console-page-shell';
import { listItems } from './actions';
import { WorkList } from './work-list';
import {
  matchesWorkView,
  parseWorkListQuery,
  parseWorkViewFilters,
  WORK_PAGE_LIMIT,
  WORK_WINDOWS,
  workListHref,
  type WorkListParams,
} from './work-list-query';
import { scanWorkPages } from './work-list-scan';
import { WorkReadWarnings, WorkWorkspace } from './work-workspace';

/**
 * Unlike every other console destination, this page is not admin-gated -
 * `WorkPageShell` below only checks that a session exists. `listItems`
 * itself still requires the `work.operator` grant (see `work-router.ts`'s
 * `operator` middleware); a signed-in user without one gets a 401 tuple
 * back, rendered here as a plain "no grant" message instead of the table.
 */
type ListResult = Awaited<ReturnType<typeof listItems>>;
type ListError = NonNullable<ListResult[0]>;
type ListedWork = NonNullable<ListResult[1]>['items'][number];

/** One Work API read per request and view, shared by the body and the
 * warnings band. Throws on invalid filters or cursor. */
const readWorkView = cache(async (key: string) => {
  const query = JSON.parse(key) as WorkListParams;
  const input = parseWorkListQuery(query);
  const filters = parseWorkViewFilters(query);
  const now = Date.now();
  const filtered = Boolean(
    input.state ||
    input.repo ||
    input.principal ||
    filters.agent ||
    filters.window ||
    filters.q,
  );
  const scan = await scanWorkPages<ListedWork, ListError>({
    list: async (cursor) => {
      const [error, page] = await listItems({ ...input, cursor });
      return error ? { error } : { page };
    },
    cursor: input.cursor,
    matches: (item) => matchesWorkView(item, filters, now),
    scan: filtered,
  });
  return { input, filtered, scan };
});

async function WorkBody({ query }: { query: WorkListParams }) {
  let view;
  try {
    view = await readWorkView(JSON.stringify(query));
  } catch {
    return (
      <Text role="alert">
        Invalid Work filters or cursor.{' '}
        <Anchor href="/work">Reset filters</Anchor>
      </Text>
    );
  }
  const { input, filtered, scan } = view;
  if ('error' in scan) {
    const err = scan.error;
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
  const examined =
    scan.pages === 1
      ? `up to ${WORK_PAGE_LIMIT} native tasks`
      : `${scan.pages} pages of up to ${WORK_PAGE_LIMIT} native tasks`;
  return (
    <>
      <div className="console-workspace__section work-workspace__list">
        {scan.items.length === 0 ? (
          <Text c="dimmed" size="sm">
            {scan.nextCursor
              ? 'No matching work items yet.'
              : 'No matching work items.'}
          </Text>
        ) : (
          <WorkList items={scan.items} />
        )}
        {scan.stoppedOn && (
          <Text size="xs" c="red" role="alert">
            Stopped reading older work: {scan.stoppedOn.message}
          </Text>
        )}
        <Text size="xs" c="dimmed" data-testid="work-scan-extent">
          {filtered
            ? `Searched ${examined}${scan.nextCursor ? '; older work continues on the next page.' : ', through the oldest.'}`
            : `Showing ${examined}.`}
        </Text>
        <Group mt="sm" wrap="wrap">
          {input.cursor && (
            <Anchor href={workListHref({ ...query, cursor: undefined })}>
              First work page
            </Anchor>
          )}
          {scan.nextCursor && (
            <Anchor href={workListHref({ ...query, cursor: scan.nextCursor })}>
              {filtered ? 'Search older work →' : 'Next work page →'}
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
      warnings={
        <WorkReadWarnings
          key={JSON.stringify(query)}
          read={() =>
            readWorkView(JSON.stringify(query)).then(
              ({ scan }) => scan,
              () => undefined,
            )
          }
        />
      }
      toolbar={
        canCreateWork ? (
          <ConsoleToolbar
            action="/work"
            folded={
              [query.repo, query.agent, query.state, query.principal].filter(
                Boolean,
              ).length
            }
            primary={
              <QuickTaskButton watchedRepos={watchedRepos} size="sm" primary />
            }
          >
            <ToolbarSelect
              name="repo"
              label="Repository"
              value={query.repo}
              options={[
                {
                  value: '',
                  label: `All repositories (${watchedRepos.length})`,
                },
                ...watchedRepos.map((repo) => ({
                  value: `${repo.owner}/${repo.name}`,
                  label: `${repo.owner}/${repo.name}`,
                })),
              ]}
            />
            <ToolbarSelect
              name="agent"
              label="Agent"
              value={query.agent}
              options={[
                { value: '', label: 'All agents' },
                ...PIPELINES.map((pipeline) => ({
                  value: pipeline,
                  label: `agent:${pipeline}`,
                })),
              ]}
            />
            <ToolbarWindow
              name="window"
              label="Window"
              value={query.window ?? ''}
              options={[
                ...WORK_WINDOWS.map((window) => ({
                  value: window,
                  label: window,
                })),
                { value: '', label: 'all' },
              ]}
            />
            <ToolbarSearch
              name="q"
              label="Find"
              placeholder="title, repo, work id"
              value={query.q}
            />
            {/* Filters the mockup's toolbar does not draw, kept one click
                  away so the band stays one row. */}
            <details className="console-toolbar__more">
              <summary className="console-toolbar__field">
                More filters
                {query.state || query.principal
                  ? ` · ${[query.state, query.principal].filter(Boolean).length}`
                  : ''}
              </summary>
              <div className="console-toolbar__more-panel">
                <ToolbarSelect
                  name="state"
                  label="State"
                  value={query.state}
                  options={[
                    '',
                    'running',
                    'done',
                    'parked',
                    'failed',
                    'canceled',
                  ].map((value) => ({ value, label: value || 'All states' }))}
                />
                <input
                  className="console-toolbar__field work-principal-filter"
                  name="principal"
                  aria-label="Principal"
                  defaultValue={query.principal ?? ''}
                  maxLength={128}
                  placeholder="All principals"
                />
                <Anchor href="/work" size="sm">
                  Clear filters
                </Anchor>
              </div>
            </details>
            {/* The form's default button, so Enter in either text field
                  submits (two text fields block implicit submission without
                  one). Hidden: the mockup's toolbar shows no Apply step. */}
            <button
              type="submit"
              className="console-toolbar__implicit-submit"
              tabIndex={-1}
              aria-hidden="true"
            >
              Apply
            </button>
            {/* The header subtitle carries this link only on wide screens. */}
            <Anchor
              href="/work/schedules"
              size="sm"
              className="work-schedules-link--compact"
            >
              Schedules →
            </Anchor>
          </ConsoleToolbar>
        ) : (
          // Without the Work grant there are no filters; Schedules stays.
          <Anchor href="/work/schedules" size="sm">
            Schedules →
          </Anchor>
        )
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
  ({ watchedRepos }: WorkViewProps) => ({
    className: 'work-page-shell',
    current: 'work',
    title: 'Work',
    subtitle: (
      <>
        Admitted queue, capacity holds and{' '}
        <a href="/work/schedules" className="console-subtitle-link">
          schedules
        </a>
      </>
    ),
    // Work was the one destination with no utility cluster at all, so create
    // and refresh were unreachable from it and the mobile overflow menu
    // - the only way to reach the other destinations on a phone - was too
    // (#1810).
    utilities: (
      <>
        <div className="work-utilities work-utilities--desktop console-utilities--desktop">
          <ConsoleCommandUtilities
            watchedRepos={watchedRepos}
            includeQuickTask={false}
          />
        </div>
        <div className="work-utilities work-utilities--mobile console-utilities--mobile">
          <ConsoleCommandUtilities
            watchedRepos={watchedRepos}
            includeNavigation
            includeQuickTask={false}
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
