import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ConsoleCommandUtilities } from './console-command-utilities';

vi.mock('./quick-task-button', () => ({
  QuickTaskButton: ({ initialRepoKey }: { initialRepoKey?: string }) => (
    <button>Quick task: {initialRepoKey ?? 'default'}</button>
  ),
}));
vi.mock('./refresh-button', () => ({
  RefreshButton: ({ bustsGithubCache }: { bustsGithubCache?: boolean }) => (
    <button>Refresh: {bustsGithubCache ? 'fresh' : 'cached'}</button>
  ),
}));
vi.mock('./sign-out-button', () => ({
  SignOutButton: () => <button>Sign out</button>,
}));
vi.mock('./queue-utility-menu', () => ({
  QueueUtilityMenu: ({
    includeNavigation,
    navigationHrefs,
    signOutControl,
  }: {
    includeNavigation?: boolean;
    navigationHrefs?: { sessions?: string };
    signOutControl: ReactNode;
  }) => (
    <div>
      {includeNavigation ? `Navigate: ${navigationHrefs?.sessions}` : 'Menu'}
      {signOutControl}
    </div>
  ),
}));

const watchedRepos = [{ owner: 'example', name: 'console' }];

describe('ConsoleCommandUtilities', () => {
  it('keeps create, refresh, and secondary controls in the same order', () => {
    render(
      <MantineProvider>
        <ConsoleCommandUtilities
          watchedRepos={watchedRepos}
          initialRepoKey="example/console"
          bustsGithubCache
          includeNavigation
          navigationHrefs={{ sessions: '/sessions?days=90' }}
        />
      </MantineProvider>,
    );

    expect(screen.getByText('Quick task: example/console')).toBeTruthy();
    expect(screen.getByText('Refresh: fresh')).toBeTruthy();
    expect(screen.getByText('Navigate: /sessions?days=90')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });
});
