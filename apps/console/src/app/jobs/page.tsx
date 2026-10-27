import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { controlPlaneRepositories } from '@/lib/deployment';
import { resolvePrincipal } from '@/lib/work-grants';

import { ConsolePageShell } from '../console-page-shell';
import { JobsPanel } from './jobs-panel';

export default async function JobsPage() {
  const session = await auth();
  if (!session?.user?.login) redirect('/');
  const grant = resolvePrincipal(`github:${session.user.login}`);
  if (
    !grant?.scopes.includes('work.operator') ||
    !grant.pipelines.includes('goose')
  )
    return (
      <ConsolePageShell route="jobs">
        <p>A Goose operator grant is required.</p>
      </ConsolePageShell>
    );
  return (
    <ConsolePageShell route="jobs">
      <h1>Repository jobs</h1>
      <JobsPanel repositories={controlPlaneRepositories()} />
    </ConsolePageShell>
  );
}
