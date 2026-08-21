import { Stack, Text } from '@mantine/core';
import { Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../auth';
import { getAutoscalerStatuses } from '../../lib/autoscaler-status';
import { getWatchedRepos } from '../../lib/github-client';
import { ConsoleCommandUtilities } from '../console-command-utilities';
import { DataWarnings } from '../console-header';
import { NavPageLoading, PageLoading } from '../page-loading';
import { RunnerAutoscalerStatus } from '../runner-autoscaler-status';
import { withConsolePageShell } from '../with-console-page-shell';

async function ShuttlebayBody() {
  const autoscaler = await getAutoscalerStatuses();

  return (
    <>
      <DataWarnings warnings={autoscaler.warnings} />
      <Stack gap="md">
        <Text c="dimmed" size="sm">
          Refreshes automatically every 10 seconds.
        </Text>
        <RunnerAutoscalerStatus initial={autoscaler} />
      </Stack>
    </>
  );
}

interface ShuttlebayViewProps {
  watchedRepos: ReturnType<typeof getWatchedRepos>;
}

function ShuttlebayViewContent() {
  return (
    <Suspense fallback={<PageLoading rows={4} header={false} />}>
      <ShuttlebayBody />
    </Suspense>
  );
}

const ShuttlebayView = withConsolePageShell(
  ShuttlebayViewContent,
  ({ watchedRepos }: ShuttlebayViewProps) => ({
    className: 'shuttlebay-page-shell',
    current: 'shuttlebay',
    title: 'Shuttlebay',
    subtitle: 'Live runner fleet and queue status',
    utilities: (
      <>
        <div className="shuttlebay-utilities shuttlebay-utilities--desktop">
          <ConsoleCommandUtilities watchedRepos={watchedRepos} />
        </div>
        <div className="shuttlebay-utilities shuttlebay-utilities--mobile">
          <ConsoleCommandUtilities
            watchedRepos={watchedRepos}
            includeNavigation
          />
        </div>
      </>
    ),
  }),
);

async function ShuttlebayPageShell() {
  const session = await auth();
  assertAdmin(session, '/login');
  const watchedRepos = getWatchedRepos();

  return <ShuttlebayView watchedRepos={watchedRepos} />;
}

// Keep authentication and the uncached Firestore snapshot below the same
// streaming boundaries as every other console destination. The header is
// immediately recognizable while the runner projection resolves.
export default function ShuttlebayPage() {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="shuttlebay"
          title="Shuttlebay"
          className="shuttlebay-page-shell"
          rows={4}
        />
      }
    >
      <ShuttlebayPageShell />
    </Suspense>
  );
}
