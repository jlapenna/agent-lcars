import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '../../lib/agent-activity';
import { RecentOutcomesSection } from './recent-outcomes-section';

// Same isolation strategy as the other /agents section tests: this
// component's own job is grouping recentRuns by pipeline, not rendering a
// row - FinishedRunRow's own rendering is covered by
// agent-activity-panel.test.tsx.
vi.mock('../agent-activity-panel', () => ({
  FinishedRunRow: ({
    run,
    session,
  }: {
    run: AgentRun;
    session?: IssueAgentSessionDoc;
  }) => (
    <div data-testid={`finished-run-${run.id}`}>
      {run.pipeline}
      {session ? ` (${session.sessionId})` : ''}
    </div>
  ),
}));

function makeAgentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 1,
    pipeline: 'claude',
    status: 'completed',
    conclusion: 'success',
    event: 'issues',
    url: 'https://github.com/o/r/actions/runs/1',
    displayTitle: '#1: A run',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:05:00.000Z',
    elapsedSeconds: 300,
    ...overrides,
  };
}

describe('RecentOutcomesSection', () => {
  it('shows the empty state when there are no recent runs', () => {
    render(
      <MantineProvider>
        <RecentOutcomesSection recentRuns={[]} />
      </MantineProvider>,
    );
    expect(screen.getByText('No recently finished runs.')).toBeTruthy();
  });

  it('groups runs under their own pipeline heading', () => {
    render(
      <MantineProvider>
        <RecentOutcomesSection
          recentRuns={[
            makeAgentRun({ id: 1, pipeline: 'claude' }),
            makeAgentRun({ id: 2, pipeline: 'claude' }),
            makeAgentRun({ id: 3, pipeline: 'opencode' }),
          ]}
        />
      </MantineProvider>,
    );

    expect(screen.getByText('claude (2)')).toBeTruthy();
    expect(screen.getByText('opencode (1)')).toBeTruthy();
    expect(screen.getByTestId('finished-run-1')).toBeTruthy();
    expect(screen.getByTestId('finished-run-2')).toBeTruthy();
    expect(screen.getByTestId('finished-run-3')).toBeTruthy();
  });

  it('forwards the joined session doc to FinishedRunRow when one exists', () => {
    render(
      <MantineProvider>
        <RecentOutcomesSection
          recentRuns={[makeAgentRun({ id: 1, pipeline: 'claude' })]}
          sessionsByRunId={{
            1: {
              sessionId: 'runner-session-1',
              source: 'issue-agent',
              liveness: 'ended',
              startedAt: '2026-07-18T00:00:00.000Z',
              lastActivityAt: '2026-07-18T00:05:00.000Z',
              turns: 3,
              toolCallCounts: {},
              tokens: {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
              },
              deliverables: { prNumbers: [], commitShas: [] },
              runId: '1',
            },
          }}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('finished-run-1')).toHaveTextContent(
      '(runner-session-1)',
    );
  });

  it('omits a pipeline heading entirely when that pipeline has no recent runs', () => {
    render(
      <MantineProvider>
        <RecentOutcomesSection
          recentRuns={[makeAgentRun({ id: 1, pipeline: 'claude' })]}
        />
      </MantineProvider>,
    );
    expect(screen.queryByText(/^opencode/)).toBeNull();
  });

  it('scopes each finished-run row under its own pipeline group', () => {
    render(
      <MantineProvider>
        <RecentOutcomesSection
          recentRuns={[
            makeAgentRun({ id: 1, pipeline: 'claude' }),
            makeAgentRun({ id: 3, pipeline: 'opencode' }),
          ]}
        />
      </MantineProvider>,
    );
    const container = screen.getByTestId('recent-outcomes');
    expect(within(container).getAllByText(/^(claude|opencode)$/)).toHaveLength(
      2,
    );
  });
});
