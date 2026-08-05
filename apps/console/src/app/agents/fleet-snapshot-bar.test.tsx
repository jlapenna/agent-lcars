import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentActivity, AgentRun } from '../../lib/agent-activity';
import { FleetSnapshotBar } from './fleet-snapshot-bar';

// Reuse the same isolation strategy as agent-activity-panel.test.tsx: keep
// this test focused on FleetSnapshotBar's own composition (which props it
// passes to which shared component), not on the shared components'
// internals - those already have dedicated coverage in
// agent-activity-panel.test.tsx.
vi.mock('../agent-activity-panel', () => ({
  PipelineBadge: ({ pipeline }: { pipeline: string }) => (
    <span data-testid={`pipeline-badge-${pipeline}`}>{pipeline}</span>
  ),
  FleetChip: ({ fleet }: { fleet?: { online: number; busy: number } }) => (
    <span data-testid="fleet-chip">
      {fleet ? `${fleet.online} online` : 'unavailable'}
    </span>
  ),
  QueueHealthAlert: ({ liveRuns }: { liveRuns: AgentRun[] }) =>
    liveRuns.some((run) => run.status === 'queued') ? (
      <div data-testid="queue-alert" />
    ) : null,
}));

function makeAgentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 1,
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
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

const EMPTY_ACTIVITY: AgentActivity = {
  liveRuns: [],
  recentRuns: [],
  fleet: { online: 0, busy: 0 },
  warnings: [],
};

function renderBar(
  activity: AgentActivity = EMPTY_ACTIVITY,
  activeCliSessionCount = 0,
  metrics?: {
    logicalTaskCount: number;
    queuedAttempts: number;
    runningAttempts: number;
    onlineRunners?: number;
    busyRunners?: number;
  },
) {
  render(
    <MantineProvider>
      <FleetSnapshotBar
        activity={activity}
        activeCliSessionCount={activeCliSessionCount}
        metrics={metrics}
      />
    </MantineProvider>,
  );
}

describe('FleetSnapshotBar', () => {
  it('counts live runs per pipeline separately', () => {
    renderBar({
      ...EMPTY_ACTIVITY,
      liveRuns: [
        makeAgentRun({ id: 1, pipeline: 'claude' }),
        makeAgentRun({ id: 2, pipeline: 'claude' }),
        makeAgentRun({ id: 3, pipeline: 'opencode' }),
      ],
    });

    expect(screen.getByText('2 live')).toBeTruthy();
    expect(screen.getByText('1 live')).toBeTruthy();
  });

  it('renders the active CLI session count', () => {
    renderBar(EMPTY_ACTIVITY, 3);
    expect(screen.getByText('3 active')).toBeTruthy();
  });

  it('passes the fleet summary through to the shared fleet chip', () => {
    renderBar({ ...EMPTY_ACTIVITY, fleet: { online: 4, busy: 2 } });
    expect(screen.getByTestId('fleet-chip')).toHaveTextContent('4 online');
  });

  it('renders the queue-stall alert when a run is stalled', () => {
    renderBar({
      ...EMPTY_ACTIVITY,
      liveRuns: [makeAgentRun({ status: 'queued', elapsedSeconds: 999 })],
    });
    expect(screen.getByTestId('queue-alert')).toBeTruthy();
  });

  it('renders no queue alert when nothing is stalled', () => {
    renderBar(EMPTY_ACTIVITY);
    expect(screen.queryByTestId('queue-alert')).toBeNull();
  });

  it('renders no metrics row at all when no metrics are supplied (back-compat)', () => {
    renderBar(EMPTY_ACTIVITY);
    expect(screen.queryByTestId('activity-metrics-row')).toBeNull();
  });

  it('renders logical-task, queued-attempt, and running-attempt counts as visibly distinct numbers (#306)', () => {
    renderBar(EMPTY_ACTIVITY, 0, {
      logicalTaskCount: 2,
      queuedAttempts: 1,
      runningAttempts: 3,
      onlineRunners: 5,
      busyRunners: 2,
    });

    expect(screen.getByTestId('metric-logical-tasks').textContent).toBe(
      '2 logical tasks',
    );
    expect(screen.getByTestId('metric-queued-attempts').textContent).toBe(
      '1 queued attempt',
    );
    expect(screen.getByTestId('metric-running-attempts').textContent).toBe(
      '3 running attempts',
    );
    expect(screen.getByTestId('metric-runner-occupancy').textContent).toBe(
      '2/5 runners busy',
    );
  });

  it('omits the runner-occupancy metric when the runner API was unavailable', () => {
    renderBar(EMPTY_ACTIVITY, 0, {
      logicalTaskCount: 0,
      queuedAttempts: 0,
      runningAttempts: 0,
    });
    expect(screen.queryByTestId('metric-runner-occupancy')).toBeNull();
  });
});
