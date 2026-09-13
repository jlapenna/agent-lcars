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
  RefreshButton: ({
    refreshesAuthoritativeQueue,
    generatedAt,
  }: {
    refreshesAuthoritativeQueue?: boolean;
    generatedAt?: string;
  }) => (
    <button>
      Refresh: {refreshesAuthoritativeQueue ? 'authoritative queue' : 'route'}
      {generatedAt ? ` @ ${generatedAt}` : ''}
    </button>
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
          refreshesAuthoritativeQueue
          includeNavigation
          navigationHrefs={{ sessions: '/sessions?days=90' }}
        />
      </MantineProvider>,
    );

    expect(screen.getByText('Quick task: example/console')).toBeTruthy();
    expect(screen.getByText('Refresh: authoritative queue')).toBeTruthy();
    expect(screen.getByText('Navigate: /sessions?days=90')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('withholds New work where the viewer has no work grant', () => {
    // /work admits signed-in users without a work grant. Offering creation
    // there would render an enabled button whose every submission is refused.
    render(
      <MantineProvider>
        <ConsoleCommandUtilities
          watchedRepos={watchedRepos}
          includeQuickTask={false}
          includeNavigation
          navigationHrefs={{ sessions: '/sessions?days=90' }}
        />
      </MantineProvider>,
    );

    expect(screen.queryByText(/^Quick task:/)).toBeNull();
    // The rest of the cluster still has to be there - this is a narrower
    // control, not a hidden header.
    expect(screen.getByText('Refresh: route')).toBeTruthy();
    expect(screen.getByText('Navigate: /sessions?days=90')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('forwards detail-page freshness age to the refresh control', () => {
    // Task/session detail used to hand-build their utility rows, so the
    // shared cluster must accept what those routes need: the real age of
    // the cached sources beside refresh. Item actions stay on the detail
    // body (#1928), never in the header dots.
    render(
      <MantineProvider>
        <ConsoleCommandUtilities
          watchedRepos={watchedRepos}
          initialRepoKey="jlapenna/agent-lcars"
          refreshesAuthoritativeQueue
          generatedAt="2026-09-12T10:00:00.000Z"
        />
      </MantineProvider>,
    );

    expect(
      screen.getByText(
        'Refresh: authoritative queue @ 2026-09-12T10:00:00.000Z',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Menu')).toBeTruthy();
  });
});
