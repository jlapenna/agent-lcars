import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '../lib/agent-activity';
import { ActiveDispatchesPanel, RecentCompletionsPanel } from './ops-panels';

const now = Date.parse('2026-10-14T08:00:00Z');

function run(id: string, pipeline: AgentRun['pipeline']): AgentRun {
  return {
    id,
    repo: { owner: 'jlapenna', name: 'agent-lcars' },
    pipeline,
    status: 'in_progress',
    url: 'https://github.com/jlapenna/agent-lcars/issues/1',
    displayTitle: '#1: console',
    issueNumber: 1,
    createdAt: '2026-10-14T07:50:00Z',
    updatedAt: '2026-10-14T07:59:00Z',
    elapsedSeconds: 600,
  };
}

describe('ActiveDispatchesPanel', () => {
  afterEach(() => vi.restoreAllMocks());

  it("heads the panel with the mockup's agent split and read age", () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    render(
      <MantineProvider>
        <ActiveDispatchesPanel
          liveRuns={[run('a', 'claude'), run('b', 'claude'), run('c', 'codex')]}
          updatedAt="2026-10-14T07:56:00Z"
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('current-work')).toHaveTextContent(
      'claude 2 · codex 1 · updated 4m ago',
    );
  });

  it('omits the separator when no run is live', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    render(
      <MantineProvider>
        <ActiveDispatchesPanel liveRuns={[]} updatedAt="2026-10-14T07:56:00Z" />
      </MantineProvider>,
    );
    const head = screen.getByTestId('current-work');
    expect(head).toHaveTextContent('updated 4m ago');
    expect(head).not.toHaveTextContent('· updated');
  });
});

describe('RecentCompletionsPanel', () => {
  it("heads the panel with the mockup's merged count when one is given", () => {
    render(
      <MantineProvider>
        <RecentCompletionsPanel
          runs={[{ ...run('a', 'claude'), status: 'completed' }]}
          merged={{ count: 14, partial: false }}
        />
      </MantineProvider>,
    );
    const head = screen.getByTestId('latest-outcomes');
    expect(head).toHaveTextContent('14 merged · 24h');
    expect(head).toHaveTextContent('last 1');
  });

  it('marks a partial merged count as a lower bound', () => {
    render(
      <MantineProvider>
        <RecentCompletionsPanel
          runs={[]}
          merged={{ count: 3, partial: true }}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('latest-outcomes')).toHaveTextContent(
      '3+ merged · 24h',
    );
  });

  it('counts the listed runs when no merged count is given', () => {
    render(
      <MantineProvider>
        <RecentCompletionsPanel runs={[]} />
      </MantineProvider>,
    );
    expect(screen.getByTestId('latest-outcomes')).toHaveTextContent(
      '0 succeeded · last 0',
    );
  });
});
