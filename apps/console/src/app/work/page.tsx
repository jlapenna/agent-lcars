import { PIPELINES } from '@agent-lcars/work';
import { Anchor, Stack, Text } from '@mantine/core';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { auth } from '@/auth';
import { controlPlaneRepository } from '@/lib/deployment';

import { NavPageLoading, PageLoading } from '../page-loading';
import { withConsolePageShell } from '../with-console-page-shell';
import { createItem, listItems } from './actions';
import { WorkCreateForm } from './work-create-form';
import { WorkList } from './work-list';

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
      <Text c="dimmed" size="sm">
        {err.code === 'UNAUTHORIZED'
          ? 'Your GitHub login has no work grant.'
          : `Could not load work items: ${err.message}`}
      </Text>
    );
  }
  return (
    <Stack gap="lg">
      <WorkCreateForm
        create={createItem}
        defaultRepo={controlPlaneRepository()}
        pipelines={PIPELINES}
      />
      <WorkList items={data.items} />
    </Stack>
  );
}

function WorkViewContent() {
  return (
    <>
      <Anchor href="/work/schedules" size="sm">
        Schedules →
      </Anchor>
      <Suspense fallback={<PageLoading rows={4} header={false} />}>
        <WorkBody />
      </Suspense>
    </>
  );
}

const WorkView = withConsolePageShell(WorkViewContent, {
  className: 'work-page-shell',
  current: 'work',
  title: 'Work',
  subtitle: 'Native work items',
});

async function WorkPageShell() {
  const session = await auth();
  if (!session) redirect('/login');

  return <WorkView />;
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
