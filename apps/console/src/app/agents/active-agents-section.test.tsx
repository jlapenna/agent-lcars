import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '../../lib/agent-activity';
import type { CliSession } from '../../lib/cli-sessions';
import { ActiveAgentsSection } from './active-agents-section';

// This section's own job is choosing WHICH runs and sessions reach the
// shared panels, and asking for the Runner column; the panels' rendering is
// covered by ops-panels.test.tsx.
vi.mock('../ops-panels', () => ({
  ActiveDispatchesPanel: ({
    liveRuns,
    showRunner,
    sessionsByRunId = {},
  }: {
    liveRuns: AgentRun[];
    showRunner?: boolean;
    sessionsByRunId?: Record<string, { sessionId: string }>;
  }) => (
    <div data-testid="dispatches" data-runner={showRunner ? '' : undefined}>
      {liveRuns
        .map((run) => `${run.id}${sessionsByRunId[run.id] ? ':s' : ''}`)
        .join(',')}
    </div>
  ),
  CliSessionsPanel: ({ sessions }: { sessions: CliSession[] }) => (
    <div data-testid="cli-panel">
      {sessions.map((session) => session.sessionId).join(',')}
    </div>
  ),
}));

const run = (id: string) =>
  ({ id, pipeline: 'claude', status: 'running' }) as unknown as AgentRun;
const session = (sessionId: string) =>
  ({ sessionId, liveness: 'live' }) as unknown as CliSession;

describe('ActiveAgentsSection', () => {
  it('renders the dispatch table with its Runner column', () => {
    render(
      <MantineProvider>
        <ActiveAgentsSection
          liveRuns={[run('42')]}
          itemsByRunId={{}}
          activeSessions={[]}
          items={[]}
          sessionsByRunId={{ 42: { sessionId: 's-1' } as never }}
        />
      </MantineProvider>,
    );
    const dispatches = screen.getByTestId('dispatches');
    expect(dispatches).toHaveAttribute('data-runner', '');
    expect(dispatches).toHaveTextContent('42:s');
    expect(screen.queryByTestId('cli-panel')).toBeNull();
    expect(screen.getByTestId('active-agents-section')).toBeTruthy();
  });

  it('adds the CLI sessions panel only when sessions are active', () => {
    render(
      <MantineProvider>
        <ActiveAgentsSection
          liveRuns={[]}
          itemsByRunId={{}}
          activeSessions={[session('abc')]}
          items={[]}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('cli-panel')).toHaveTextContent('abc');
  });
});
