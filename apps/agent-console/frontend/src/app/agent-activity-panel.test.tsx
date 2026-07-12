import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';

import type { AgentActivity } from '../lib/agent-activity';
import type { CliSession } from '../lib/cli-sessions';
import { AgentActivityPanel } from './agent-activity-panel';

// CancelRunButton is a 'use server' client component wired to backend
// actions - out of scope here, matching the pattern in
// action-items-board.test.tsx.
jest.mock('./cancel-run-button', () => ({
  CancelRunButton: () => null,
}));

// agent-activity.ts pulls in the server-only (ESM) GitHub client - stub the
// one runtime value this panel actually uses (RUN_TIMEOUT_MINUTES) so the
// module never loads at test time. Every other import from it is type-only.
jest.mock('../lib/agent-activity', () => ({ RUN_TIMEOUT_MINUTES: 90 }));

const EMPTY_ACTIVITY: AgentActivity = {
  liveRuns: [],
  recentRuns: [],
  runners: [],
  warnings: [],
};

function makeCliSession(overrides: Partial<CliSession> = {}): CliSession {
  return {
    sessionId: 'session-1',
    liveness: 'live',
    host: 'joes-workstation',
    branch: 'feat/agent-console-cli-sessions',
    turns: 4,
    totalTokens: 1200,
    startedAt: '2026-07-12T00:00:00.000Z',
    lastActivityAt: '2026-07-12T00:05:00.000Z',
    ...overrides,
  };
}

function renderPanel(cliSessions: CliSession[]) {
  render(
    <MantineProvider>
      <AgentActivityPanel activity={EMPTY_ACTIVITY} cliSessions={cliSessions} />
    </MantineProvider>,
  );
}

describe('AgentActivityPanel CLI sessions', () => {
  it('renders nothing extra when there are no CLI sessions', () => {
    renderPanel([]);
    expect(screen.queryByText('CLI sessions')).toBeNull();
  });

  it('renders a CLI session with host, branch, turns, tokens, and liveness', () => {
    renderPanel([
      makeCliSession({ title: 'Merge live CLI sessions into the list' }),
    ]);

    expect(screen.getByText('CLI sessions')).toBeTruthy();
    expect(screen.getByText('live')).toBeTruthy();
    expect(
      screen.getByText('Merge live CLI sessions into the list'),
    ).toBeTruthy();
    expect(screen.getByText('joes-workstation')).toBeTruthy();
    expect(screen.getByText(/feat\/agent-console-cli-sessions/)).toBeTruthy();
    expect(screen.getByText('4 turns')).toBeTruthy();
    expect(screen.getByText('1.2k tokens')).toBeTruthy();
  });

  it('links to the joined PR when one exists', () => {
    renderPanel([
      makeCliSession({
        pr: {
          number: 2587,
          title: 'feat: cli sessions',
          url: 'https://github.com/o/r/pull/2587',
        },
      }),
    ]);

    const link = screen.getByRole('link', { name: /PR #2587/ });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/o/r/pull/2587',
    );
  });

  it('visually distinguishes each liveness state', () => {
    renderPanel([
      makeCliSession({ sessionId: 's-live', liveness: 'live' }),
      makeCliSession({ sessionId: 's-idle', liveness: 'idle' }),
      makeCliSession({ sessionId: 's-ended', liveness: 'ended' }),
      makeCliSession({ sessionId: 's-stale', liveness: 'stale' }),
    ]);

    for (const label of ['live', 'idle', 'ended', 'stale']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});
