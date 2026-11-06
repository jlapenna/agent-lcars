import { Anchor, Group, Stack, Text } from '@mantine/core';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { auth } from '@/auth';
import { getWatchedRepos } from '@/lib/github-client';
import { linearConfig } from '@/lib/linear-config';
import { resolvePrincipal, workGrants } from '@/lib/work-grants';

import { ConsoleCommandUtilities } from '../../console-command-utilities';
import { ConsoleToolbar, ToolbarSelect } from '../../console-toolbar';
import { OpsPanel } from '../../ops-primitives';
import { NavPageLoading } from '../../page-loading';
import { withConsolePageShell } from '../../with-console-page-shell';
import { WorkWorkspace } from '../work-workspace';
import { listSources } from './actions';
import { RefreshIssueSources, RunIssue } from './issue-controls';

type Query = { tracker?: string; repo?: string; cursor?: string };
async function IssuesContent({ query }: { query: Query }) {
  const session = await auth();
  if (!session) redirect('/login');
  const tracker = query.tracker === 'linear' ? 'linear' : 'github';
  const principal = session.user?.login
    ? resolvePrincipal(`github:${session.user.login}`, workGrants())
    : undefined;
  const canRun = principal?.scopes.includes('work.operator') === true;
  const repositories = getWatchedRepos().map(
    (repo) => `${repo.owner}/${repo.name}`,
  );
  const config = linearConfig();
  const teams = [...new Set(config?.routes.map((route) => route.teamId))].map(
    (id, index) => ({
      id,
      name:
        config?.teams?.find((team) => team.teamId === id)?.name ??
        `Configured team ${index + 1}`,
    }),
  );
  const [error, page] = await listSources({
    tracker,
    ...(query.repo ? { repo: query.repo } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    limit: 50,
  });
  return (
    <WorkWorkspace
      ariaLabel="Issue sources"
      warnings={false}
      toolbar={
        <ConsoleToolbar
          action="/work/issues"
          primary={
            canRun ? (
              <RefreshIssueSources tracker={tracker} teams={teams} />
            ) : undefined
          }
        >
          <ToolbarSelect
            name="tracker"
            label="Tracker"
            value={tracker}
            options={[
              { value: 'github', label: 'GitHub' },
              { value: 'linear', label: 'Linear' },
            ]}
          />
          <ToolbarSelect
            name="repo"
            label="Repository"
            value={query.repo}
            options={[
              { value: '', label: 'All repositories' },
              ...repositories.map((value) => ({ value, label: value })),
            ]}
          />
          <Anchor href="/work">Work history →</Anchor>
        </ConsoleToolbar>
      }
    >
      <OpsPanel
        title="Issue sources"
        count={page?.issues.length}
        meta="Current tracker state"
      >
        {error ? (
          <Text role="alert">Could not read issues: {error.message}</Text>
        ) : (
          <Stack gap="lg">
            {page.issues.length === 0 ? (
              <Text c="dimmed">
                No issues on this page. Refresh the tracker to load its current
                issues.
              </Text>
            ) : null}
            {page.issues.map((source) => {
              const reference = source.issue.reference;
              const choices =
                reference.tracker === 'linear'
                  ? (config?.routes ?? [])
                      .filter(
                        (route) =>
                          route.teamId === source.issue.teamId &&
                          principal?.pipelines.includes(route.pipeline),
                      )
                      .map(({ repo, pipeline }) => ({ repo, pipeline }))
                  : (principal?.pipelines ?? [])
                      .filter(
                        (
                          pipeline,
                        ): pipeline is
                          'claude' | 'codex' | 'opencode' | 'agy' =>
                          ['claude', 'codex', 'opencode', 'agy'].includes(
                            pipeline,
                          ),
                      )
                      .map((pipeline) => ({ repo: reference.repo, pipeline }));
              return (
                <Group
                  key={source.issue.url}
                  justify="space-between"
                  align="flex-start"
                  wrap="wrap"
                >
                  <Stack gap={4}>
                    <Anchor
                      href={source.issue.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {source.issue.identifier} · {source.issue.title}
                    </Anchor>
                    <Text size="xs" c="dimmed">
                      {reference.tracker === 'linear' ? 'Linear' : 'GitHub'} ·{' '}
                      {source.repo ?? 'Repository not selected'} ·{' '}
                      {source.issue.status?.name ?? source.issue.state}
                    </Text>
                    <Text size="xs">
                      {source.issue.assignees
                        .map((assignee) => assignee.name)
                        .join(', ') || 'Unassigned'}
                    </Text>
                  </Stack>
                  {source.workId ? (
                    <Anchor href={`/work/${source.workId}`}>Open Work →</Anchor>
                  ) : canRun ? (
                    <RunIssue
                      issue={reference}
                      repository={source.repo}
                      choices={choices}
                    />
                  ) : null}
                </Group>
              );
            })}
            {page.nextCursor ? (
              <Anchor
                href={`/work/issues?${new URLSearchParams({ tracker, ...(query.repo ? { repo: query.repo } : {}), cursor: page.nextCursor })}`}
              >
                Next issues →
              </Anchor>
            ) : null}
          </Stack>
        )}
      </OpsPanel>
    </WorkWorkspace>
  );
}

const IssuesView = withConsolePageShell(IssuesContent, () => ({
  current: 'work',
  title: 'Issue sources',
  subtitle: 'GitHub and Linear',
  className: 'work-page-shell',
  utilities: (
    <>
      <div className="console-utilities--desktop">
        <ConsoleCommandUtilities
          watchedRepos={getWatchedRepos()}
          includeQuickTask={false}
        />
      </div>
      <div className="console-utilities--mobile">
        <ConsoleCommandUtilities
          watchedRepos={getWatchedRepos()}
          includeNavigation
          includeQuickTask={false}
        />
      </div>
    </>
  ),
}));
export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="work"
          title="Issue sources"
          className="work-page-shell"
          rows={4}
        />
      }
    >
      <IssuesView query={await searchParams} />
    </Suspense>
  );
}
