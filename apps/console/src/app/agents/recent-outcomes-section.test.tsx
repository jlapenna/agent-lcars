import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '../../lib/agent-activity';
import { RecentOutcomesSection } from './recent-outcomes-section';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/agents',
  useSearchParams: () => new URLSearchParams(),
}));

function makeAgentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 1,
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
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
  it('omits itself when there are no recent runs', () => {
    render(
      <MantineProvider>
        <RecentOutcomesSection recentRuns={[]} />
      </MantineProvider>,
    );
    expect(screen.queryByTestId('recent-outcomes')).toBeNull();
  });

  it('lists every run with its agent in one completions table', () => {
    render(
      <MantineProvider>
        <RecentOutcomesSection
          recentRuns={[
            makeAgentRun({ id: 1, pipeline: 'claude' }),
            makeAgentRun({ id: 2, pipeline: 'opencode' }),
          ]}
        />
      </MantineProvider>,
    );
    const panel = screen.getByTestId('recent-outcomes');
    expect(within(panel).getAllByTestId('finished-run-row')).toHaveLength(2);
    expect(within(panel).getByText('claude')).toBeTruthy();
    expect(within(panel).getByText('opencode')).toBeTruthy();
    expect(
      within(panel).getByRole('columnheader', { name: 'Agent' }),
    ).toBeTruthy();
  });

  it('links a run to its joined session when one exists', () => {
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
            } as unknown as IssueAgentSessionDoc,
          }}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('finished-run-session-link')).toHaveAttribute(
      'href',
      '/sessions/runner-session-1',
    );
  });

  it('marks outcomes after the newest five for the mobile disclosure', () => {
    render(
      <MantineProvider>
        <RecentOutcomesSection
          recentRuns={Array.from({ length: 7 }, (_, index) =>
            makeAgentRun({
              id: index + 1,
              pipeline: index < 6 ? 'claude' : 'codex',
            }),
          )}
        />
      </MantineProvider>,
    );

    const disclosure = screen.getByTestId('recent-outcomes-disclosure');
    expect(
      disclosure.querySelectorAll('[data-mobile-history-extra="true"]'),
    ).toHaveLength(2);

    const toggle = screen.getByRole('button', {
      name: 'Show 2 older outcomes',
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(disclosure).toHaveAttribute('data-expanded', 'true');
    expect(toggle).toHaveTextContent('Show fewer outcomes');
  });

  it('uses a singular label when exactly one older outcome is hidden', () => {
    render(
      <MantineProvider>
        <RecentOutcomesSection
          recentRuns={Array.from({ length: 6 }, (_, index) =>
            makeAgentRun({ id: index + 1 }),
          )}
        />
      </MantineProvider>,
    );

    const toggle = screen.getByRole('button', {
      name: 'Show 1 older outcome',
    });
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent('Show fewer outcomes');
  });
});
