import { PIPELINES } from '@agent-lcars/work';
import { Text } from '@mantine/core';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { auth } from '@/auth';
import { controlPlaneRepository } from '@/lib/deployment';

import { NavPageLoading, PageLoading } from '../../page-loading';
import { withConsolePageShell } from '../../with-console-page-shell';
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
      <Text c="dimmed" size="sm">
        {err.code === 'UNAUTHORIZED'
          ? 'Your GitHub login has no work grant.'
          : `Could not load schedules: ${err.message}`}
      </Text>
    );
  }
  return (
    <>
      <ScheduleCreateForm
        create={createSchedule}
        defaultRepo={controlPlaneRepository()}
        pipelines={PIPELINES}
      />
      <ScheduleList
        schedules={data.schedules}
        enable={enableSchedule}
        disable={disableSchedule}
      />
    </>
  );
}

function SchedulesViewContent() {
  return (
    <Suspense fallback={<PageLoading rows={4} header={false} />}>
      <SchedulesBody />
    </Suspense>
  );
}

const SchedulesView = withConsolePageShell(SchedulesViewContent, {
  className: 'work-schedules-page-shell',
  current: 'work',
  title: 'Schedules',
  subtitle: 'Recurring native work',
});

async function SchedulesPageShell() {
  const session = await auth();
  if (!session) redirect('/login');
  return <SchedulesView />;
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
