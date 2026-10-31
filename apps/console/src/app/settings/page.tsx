import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { auth } from '@/auth';
import { getWatchedRepos } from '@/lib/github-client';

import { ConsoleCommandUtilities } from '../console-command-utilities';
import { AccountIdentity } from '../console-frame-readouts';
import { DetailWorkspace } from '../detail-workspace';
import { InboxNotificationsToggle } from '../inbox-notifications';
import { OpsPanel } from '../ops-primitives';
import { NavPageLoading } from '../page-loading';
import { ThemeToggle } from '../theme-toggle';
import { withConsolePageShell } from '../with-console-page-shell';

interface SettingsViewProps {
  isAdmin: boolean;
  watchedRepos: ReturnType<typeof getWatchedRepos>;
}

/** Browser and account preferences, moved off the console menu so the menu
 * stays a short list of places to go. Notifications exist only for the admin
 * session that owns the Inbox (layout.tsx mounts their provider). */
function SettingsContent({ isAdmin }: SettingsViewProps) {
  return (
    <DetailWorkspace ariaLabel="Settings">
      <OpsPanel title="Appearance" className="settings-panel">
        <ThemeToggle />
      </OpsPanel>
      {isAdmin && (
        <OpsPanel title="Inbox notifications" className="settings-panel">
          <InboxNotificationsToggle />
        </OpsPanel>
      )}
      <OpsPanel title="Account" className="settings-panel">
        <AccountIdentity />
      </OpsPanel>
    </DetailWorkspace>
  );
}

const SettingsView = withConsolePageShell(
  SettingsContent,
  ({ isAdmin, watchedRepos }: SettingsViewProps) => ({
    current: 'settings',
    title: 'Settings',
    subtitle: 'This browser and account',
    utilities: (
      <>
        <div className="console-utilities--desktop">
          <ConsoleCommandUtilities
            watchedRepos={watchedRepos}
            includeQuickTask={isAdmin}
          />
        </div>
        <div className="console-utilities--mobile">
          <ConsoleCommandUtilities
            watchedRepos={watchedRepos}
            includeNavigation
            includeQuickTask={isAdmin}
          />
        </div>
      </>
    ),
  }),
);

async function AuthenticatedSettingsPage() {
  const session = await auth();
  if (!session?.user?.login) redirect('/');
  return (
    <SettingsView
      isAdmin={session.user.isAdmin === true}
      watchedRepos={getWatchedRepos()}
    />
  );
}

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="settings"
          title="Settings"
          className="settings-page-loading"
        />
      }
    >
      <AuthenticatedSettingsPage />
    </Suspense>
  );
}
