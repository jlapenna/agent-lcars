import { PIPELINES } from '@agent-lcars/work';
import { Text } from '@mantine/core';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { auth } from '@/auth';
import { controlPlaneRepository } from '@/lib/deployment';
import { getWatchedRepos } from '@/lib/github-client';

import { ConsoleCommandUtilities } from '../../console-command-utilities';
import { NavPageLoading, PageLoading } from '../../page-loading';
import { withConsolePageShell } from '../../with-console-page-shell';
import { WorkWorkspace } from '../work-workspace';
import {
  createSchedule,
  disableSchedule,
  enableSchedule,
  listSchedules,
} from './actions';
import { ScheduleCreateForm } from './schedule-create-form';
import { ScheduleList } from './schedule-list';

async function SchedulesBody() {
  const [err, data] = await listSchedules({ limit: 200 });
  if (err) {
    return (
      <div className="work-workspace__empty">
        <Text c="dimmed" size="sm">
          {err.code === 'UNAUTHORIZED'
            ? 'Your GitHub login has no work grant.'
            : `Could not load schedules: ${err.message}`}
        </Text>
      </div>
    );
  }
  return (
    <>
      <div className="console-workspace__section work-workspace__create">
        <ScheduleCreateForm
          create={createSchedule}
          defaultRepo={controlPlaneRepository()}
          pipelines={PIPELINES}
        />
      </div>
      <div className="console-workspace__section work-workspace__list">
        <ScheduleList
          schedules={data.schedules}
          enable={enableSchedule}
          disable={disableSchedule}
        />
      </div>
    </>
  );
}

function SchedulesViewContent() {
  return (
    <WorkWorkspace ariaLabel="Work schedules">
      <Suspense fallback={<PageLoading rows={4} header={false} />}>
        <SchedulesBody />
      </Suspense>
    </WorkWorkspace>
  );
}

interface SchedulesViewProps {
  watchedRepos: ReturnType<typeof getWatchedRepos>;
  /** Quick task is admin-only on both submission paths; like `/work`, this
   *  route admits a non-admin `work.operator`. See `ConsoleCommandUtilities`. */
  canQuickTask: boolean;
}

const SchedulesView = withConsolePageShell(
  SchedulesViewContent,
  ({ watchedRepos, canQuickTask }: SchedulesViewProps) => ({
    className: 'work-schedules-page-shell',
    current: 'work',
    title: 'Schedules',
    subtitle: 'Recurring native work',
    utilities: (
      <>
        <div className="work-utilities work-utilities--desktop">
          <ConsoleCommandUtilities
            watchedRepos={watchedRepos}
            includeQuickTask={canQuickTask}
          />
        </div>
        <div className="work-utilities work-utilities--mobile">
          <ConsoleCommandUtilities
            watchedRepos={watchedRepos}
            includeNavigation
            includeQuickTask={canQuickTask}
          />
        </div>
      </>
    ),
  }),
);

async function SchedulesPageShell() {
  const session = await auth();
  if (!session) redirect('/login');
  return (
    <SchedulesView
      watchedRepos={getWatchedRepos()}
      canQuickTask={session.user?.isAdmin === true}
    />
  );
}

export default function SchedulesPage() {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="work"
          title="Schedules"
          className="work-schedules-page-shell"
          rows={4}
        />
      }
    >
      <SchedulesPageShell />
    </Suspense>
  );
}
