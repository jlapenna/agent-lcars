import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ActionItem } from '../../lib/action-items';
import type { AgentRun } from '../../lib/agent-activity';
import type { CliSession } from '../../lib/cli-sessions';
import type { RunItemRef } from '../agent-activity-panel';
import { ActiveAgentsSection } from './active-agents-section';

// Same isolation strategy as fleet-snapshot-bar.test.tsx: this section's own
// job is choosing WHICH runs/sessions render and what gets passed to them
// (the takeover-command join in particular) - the row components' own
// rendering is covered by agent-activity-panel.test.tsx.
vi.mock('../agent-activity-panel', () => ({
  LiveRunRow: ({
    run,
    item,
    session,
  }: {
    run: AgentRun;
    item?: RunItemRef;
    session?: IssueAgentSessionDoc;
  }) => (
    <div data-testid={`live-run-${run.id}`}>
      {item ? `#${item.number}` : ''}
      {session ? ` (${session.sessionId})` : ''}
    </div>
  ),
  CliSessionRow: ({
    session,
    takeoverCommand,
  }: {
    session: CliSession;
    takeoverCommand?: string;
  }) => (
    <div data-testid={`cli-session-${session.sessionId}`}>
      {takeoverCommand ?? ''}
    </div>
  ),
}));

function makeAgentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 1,
    pipeline: 'claude',
    status: 'running',
    event: 'issues',
    url: 'https://github.com/o/r/actions/runs/1',
    displayTitle: '#1: A run',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    elapsedSeconds: 60,
    ...overrides,
  };
}

function makeSession(overrides: Partial<CliSession> = {}): CliSession {
  return {
    sessionId: 'session-1',
    liveness: 'live',
    agent: 'claude-code',
    turns: 1,
    totalTokens: 10,
    startedAt: '2026-07-18T00:00:00.000Z',
    lastActivityAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    number: 1,
    title: 'Fix the thing',
    url: 'https://github.com/supersprinklesracing/members/issues/1',
    updatedAt: '2026-07-18T00:00:00.000Z',
    actionTypes: [],
    labels: [],
    assigneeLogins: [],
    ...overrides,
  };
}

describe('ActiveAgentsSection', () => {
  it('shows the empty state when nothing is in flight', () => {
    render(
      <MantineProvider>
        <ActiveAgentsSection
          liveRuns={[]}
          itemsByRunId={{}}
          activeSessions={[]}
          items={[]}
        />
      </MantineProvider>,
    );
    expect(
      screen.getByText('No agent runs or CLI sessions in flight.'),
    ).toBeTruthy();
  });

  it('renders one row per live run, joined to its item when known', () => {
    render(
      <MantineProvider>
        <ActiveAgentsSection
          liveRuns={[makeAgentRun({ id: 42 })]}
          itemsByRunId={{
            42: { number: 7, title: 'Fix it', url: 'u' },
          }}
          activeSessions={[]}
          items={[]}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('live-run-42')).toHaveTextContent('#7');
  });

  it('forwards the joined session doc to LiveRunRow when one exists', () => {
    render(
      <MantineProvider>
        <ActiveAgentsSection
          liveRuns={[makeAgentRun({ id: 42 })]}
          itemsByRunId={{}}
          activeSessions={[]}
          items={[]}
          sessionsByRunId={{
            42: {
              sessionId: 'runner-session-1',
              source: 'issue-agent',
              liveness: 'live',
              startedAt: '2026-07-18T00:00:00.000Z',
              lastActivityAt: '2026-07-18T00:00:00.000Z',
              turns: 3,
              toolCallCounts: {},
              tokens: {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
              },
              deliverables: { prNumbers: [], commitShas: [] },
              runId: '42',
            },
          }}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('live-run-42')).toHaveTextContent(
      '(runner-session-1)',
    );
  });

  it('renders one row per active CLI session', () => {
    render(
      <MantineProvider>
        <ActiveAgentsSection
          liveRuns={[]}
          itemsByRunId={{}}
          activeSessions={[makeSession({ sessionId: 'abc' })]}
          items={[]}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('cli-session-abc')).toBeTruthy();
  });

  it('surfaces the takeover command of the item a session is working', () => {
    render(
      <MantineProvider>
        <ActiveAgentsSection
          liveRuns={[]}
          itemsByRunId={{}}
          activeSessions={[
            makeSession({
              sessionId: 'abc',
              pr: { number: 99, url: 'https://github.com/o/r/pull/99' },
            }),
          ]}
          items={[
            makeItem({
              number: 99,
              kind: 'pr',
              takeoverCommand: 'claude --resume abc123',
            }),
          ]}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('cli-session-abc')).toHaveTextContent(
      'claude --resume abc123',
    );
  });

  it('renders no takeover text when the matched item has none', () => {
    render(
      <MantineProvider>
        <ActiveAgentsSection
          liveRuns={[]}
          itemsByRunId={{}}
          activeSessions={[
            makeSession({
              sessionId: 'abc',
              pr: { number: 99, url: 'https://github.com/o/r/pull/99' },
            }),
          ]}
          items={[makeItem({ number: 99, kind: 'pr' })]}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('cli-session-abc')).toHaveTextContent('');
  });
});
