import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '../lib/agent-activity';
import {
  ActiveDispatchesPanel,
  DecisionInboxPanel,
  type DecisionRow,
  RecentCompletionsPanel,
} from './ops-panels';

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
          merged="14 merged · 24h"
        />
      </MantineProvider>,
    );
    const head = screen.getByTestId('latest-outcomes');
    expect(head).toHaveTextContent('14 merged · 24h');
    expect(head).toHaveTextContent('last 1');
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

describe('DecisionInboxPanel', () => {
  const decision = (index: number): DecisionRow => ({
    key: `d${index}`,
    reason: 'Needs input',
    title: `Decision ${index}`,
    ref: `#${index}`,
    refHref: `/work/${index}`,
    waitingSince: '2026-10-14T07:00:00Z',
    respondHref: `/inbox?select=${index}`,
  });

  it('lists the first rows and links to every waiting decision in the Inbox', () => {
    render(
      <MantineProvider>
        <DecisionInboxPanel
          rows={Array.from({ length: 8 }, (_, i) => decision(i + 1))}
          inboxHref="/inbox?repo=octo%2Fexample"
        />
      </MantineProvider>,
    );
    expect(screen.getAllByTestId('decision-row')).toHaveLength(5);
    const more = screen.getByTestId('decision-inbox-more');
    expect(more).toHaveTextContent('Showing 5 of 8 · view all in Inbox →');
    expect(more).toHaveAttribute('href', '/inbox?repo=octo%2Fexample');
  });

  it('omits the Inbox link while every decision is listed', () => {
    render(
      <MantineProvider>
        <DecisionInboxPanel rows={[decision(1)]} />
      </MantineProvider>,
    );
    expect(screen.queryByTestId('decision-inbox-more')).toBeNull();
  });
});
