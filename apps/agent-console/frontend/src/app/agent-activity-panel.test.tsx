import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';

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

// react-markdown/remark-gfm (pulled in via artifact-viewer.tsx) are ESM-only
// (unified ecosystem) - see artifact-viewer.test.tsx for the same stub.
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

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
    expect(
      screen.getByText('No agent runs or CLI sessions in flight.'),
    ).toBeTruthy();
  });

  it('renders an active CLI session with host, branch, turns, tokens, and liveness', () => {
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
          url: 'https://github.com/o/r/pull/2587',
        },
      }),
    ]);

    const link = screen.getByRole('link', { name: /PR #2587/ });
    expect(link.getAttribute('href')).toBe('https://github.com/o/r/pull/2587');
  });

  it('links to shared artifacts using host + sessionId', () => {
    renderPanel([
      makeCliSession({
        sessionId: 'abc-123',
        host: 'pike',
        artifacts: ['report.md', 'chart.png'],
      }),
    ]);

    const reportLink = screen.getByRole('link', { name: /report\.md/ });
    expect(reportLink.getAttribute('href')).toBe(
      'https://share.lan.jlapenna.net/pike/abc-123/report.md',
    );
    const chartLink = screen.getByRole('link', { name: /chart\.png/ });
    expect(chartLink.getAttribute('href')).toBe(
      'https://share.lan.jlapenna.net/pike/abc-123/chart.png',
    );
  });

  it('renders no artifacts section when the session has none', () => {
    renderPanel([makeCliSession({ artifacts: [] })]);
    expect(screen.queryByText('Artifacts:')).toBeNull();
  });

  it('keeps live/idle sessions inline and tucks ended/stale behind a collapsed disclosure', () => {
    renderPanel([
      makeCliSession({ sessionId: 's-live', liveness: 'live' }),
      makeCliSession({ sessionId: 's-idle', liveness: 'idle' }),
      makeCliSession({ sessionId: 's-ended', liveness: 'ended' }),
      makeCliSession({ sessionId: 's-stale', liveness: 'stale' }),
    ]);

    const disclosure = screen.getByTestId('recent-sessions');
    expect(disclosure).not.toHaveProperty('open', true);
    expect(screen.getByText(/Recent CLI sessions \(2\)/)).toBeTruthy();

    // The finished sessions live inside the disclosure...
    const finished = within(disclosure as HTMLElement);
    expect(finished.getByTestId('cli-session-s-ended')).toBeTruthy();
    expect(finished.getByTestId('cli-session-s-stale')).toBeTruthy();
    // ...and the active ones outside it.
    expect(finished.queryByTestId('cli-session-s-live')).toBeNull();
    expect(screen.getByTestId('cli-session-s-live')).toBeTruthy();
    expect(screen.getByTestId('cli-session-s-idle')).toBeTruthy();
  });
});
