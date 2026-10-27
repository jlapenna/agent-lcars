import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { controlPlaneRepositories } from '@/lib/deployment';
import { getWatchedRepos } from '@/lib/github-client';
import { resolvePrincipal } from '@/lib/work-grants';

import { ConsoleCommandUtilities } from '../console-command-utilities';
import { withConsolePageShell } from '../with-console-page-shell';
import { JobsPanel } from './jobs-panel';

interface JobsViewProps {
  repositories: string[];
  canManageJobs: boolean;
  watchedRepos: ReturnType<typeof getWatchedRepos>;
}

function JobsContent({ repositories, canManageJobs }: JobsViewProps) {
  return canManageJobs ? (
    <JobsPanel repositories={repositories} />
  ) : (
    <p>A Goose operator grant is required.</p>
  );
}

const JobsView = withConsolePageShell(
  JobsContent,
  ({ watchedRepos }: JobsViewProps) => ({
    current: 'jobs',
    title: 'Repository jobs',
    subtitle: 'Recipes, schedules and results',
    utilities: (
      <>
        <div className="console-utilities--desktop">
          <ConsoleCommandUtilities
            watchedRepos={watchedRepos}
            includeQuickTask={false}
          />
        </div>
        <div className="console-utilities--mobile">
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

export default async function JobsPage() {
  const session = await auth();
  if (!session?.user?.login) redirect('/');
  const grant = resolvePrincipal(`github:${session.user.login}`);
  return (
    <JobsView
      repositories={controlPlaneRepositories()}
      watchedRepos={getWatchedRepos()}
      canManageJobs={
        grant?.scopes.includes('work.operator') === true &&
        grant.pipelines.includes('goose')
      }
    />
  );
}
