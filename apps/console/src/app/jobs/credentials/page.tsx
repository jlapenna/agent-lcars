import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { auth } from '@/auth';
import { getWatchedRepos } from '@/lib/github-client';
import { resolvePrincipal } from '@/lib/work-grants';

import { ConsoleCommandUtilities } from '../../console-command-utilities';
import { ConsoleMessage } from '../../console-message';
import { NavPageLoading } from '../../page-loading';
import { withConsolePageShell } from '../../with-console-page-shell';
import { JobCredentialsPanel } from './credentials-panel';

interface ViewProps {
  allowed: boolean;
  watchedRepos: ReturnType<typeof getWatchedRepos>;
}
const View = withConsolePageShell(
  ({ allowed }: ViewProps) =>
    allowed ? (
      <JobCredentialsPanel />
    ) : (
      <ConsoleMessage ariaLabel="Credential access">
        <p>A secret administration grant is required.</p>
      </ConsoleMessage>
    ),
  ({ watchedRepos }: ViewProps) => ({
    current: 'jobs',
    title: 'Job credentials',
    subtitle: 'Secrets, credential sets and job access',
    utilities: (
      <ConsoleCommandUtilities
        watchedRepos={watchedRepos}
        includeNavigation
        includeQuickTask={false}
      />
    ),
  }),
);
async function AuthenticatedPage() {
  const session = await auth();
  if (!session?.user?.login) redirect('/');
  return (
    <View
      watchedRepos={getWatchedRepos()}
      allowed={
        resolvePrincipal(`github:${session.user.login}`)?.scopes.includes(
          'secrets.admin',
        ) === true
      }
    />
  );
}
export default function JobCredentialsPage() {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="jobs"
          title="Job credentials"
          className="jobs-page-loading"
        />
      }
    >
      <AuthenticatedPage />
    </Suspense>
  );
}
