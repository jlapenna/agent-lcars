import { MantineProvider } from '@mantine/core';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fleetFromAutoscalerStatuses,
  type FleetSummary,
} from '../lib/agent-activity';
import { projectAutoscalerStatuses } from '../lib/autoscaler-status';
import { AgentActivityPanel } from './agent-activity-panel';
import { FleetSnapshotBar } from './agents/fleet-snapshot-bar';
import { FleetChip } from './fleet-status';
import { LiveDashboard } from './live-dashboard';

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('./refresh-action', () => ({ refreshDashboard: mocks.refresh }));

const T0 = Date.parse('2026-10-09T20:00:00.000Z');
class Source {
  static instances: Source[] = [];
  onerror?: () => void;
  callback?: (event: MessageEvent) => void;
  close = vi.fn();
  constructor() {
    Source.instances.push(this);
  }
  addEventListener(_name: string, callback: (event: MessageEvent) => void) {
    this.callback = callback;
  }
  heartbeat() {
    this.callback?.(
      new MessageEvent('dashboard', {
        data: JSON.stringify({ state: 'live', changed: false }),
      }),
    );
  }
}

function records(now = T0, registered = 5) {
  const arc = {
    schemaVersion: 3,
    kind: 'arc-lane',
    lane: 'standard',
    registrationUrl: 'https://github.com/jlapenna',
    assignedJobs: 2,
    runningJobs: registered === 0 ? 0 : 2,
    pendingJobs: 0,
    idleRunners: registered === 0 ? 0 : 3,
    registeredRunners: registered,
    desiredRunners: registered,
    minRunners: 0,
    maxRunners: 10,
    updatedAt: new Date(now).toISOString(),
  };
  return [
    arc,
    {
      ...arc,
      lane: 'older-zero',
      registeredRunners: 0,
      runningJobs: 0,
      idleRunners: 0,
      updatedAt: new Date(now - 60_000).toISOString(),
    },
    {
      schemaVersion: 2,
      kind: 'queue-executor',
      executor: 'queue',
      ready: true,
      draining: false,
      activeRuns: 0,
      maxConcurrent: 8,
      updatedAt: new Date(now + 60_000).toISOString(),
    },
  ];
}

function view(surface: string, fleet: FleetSummary) {
  const activity = { liveRuns: [], recentRuns: [], warnings: [], fleet };
  return (
    <MantineProvider>
      <LiveDashboard />
      {surface === 'Bridge' ? (
        <AgentActivityPanel activity={activity} cliSessions={[]} />
      ) : (
        <FleetSnapshotBar
          activity={activity}
          activeCliSessionCount={0}
          metrics={{
            logicalTaskCount: 1,
            queuedRuns: 1,
            runningRuns: 0,
            onlineRunners: fleet.online,
            busyRunners: fleet.busy,
          }}
        />
      )}
    </MantineProvider>
  );
}

describe('producer freshness in Bridge and Agents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.stubGlobal('EventSource', Source);
    Source.instances = [];
    mocks.refresh.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ['Bridge', 'unchanged'],
    ['Agents', 'unchanged'],
    ['Bridge', 'disconnected'],
    ['Agents', 'disconnected'],
  ])(
    '%s expires ARC and executor independently during %s streams',
    async (surface, stream) => {
      const raw = records();
      const fleet = fleetFromAutoscalerStatuses(projectAutoscalerStatuses(raw));
      expect(fleet.githubExpiresAt).toBe(new Date(T0 + 120_000).toISOString());
      expect(fleet.directExecutor?.expiresAt).toBe(
        new Date(T0 + 240_000).toISOString(),
      );
      const rendered = render(view(surface, fleet));
      expect(screen.getByTestId('fleet-chip')).toHaveTextContent(
        '5 GitHub runners registered (2 running)',
      );
      expect(
        screen.queryByTestId('metric-runner-occupancy')?.textContent ?? null,
      ).toBe(surface === 'Agents' ? '2/5 GitHub runners running' : null);
      if (stream === 'disconnected') act(() => Source.instances[0].onerror?.());
      for (let i = 0; i < 13; i++) {
        await act(async () => {
          if (stream === 'unchanged') Source.instances[0].heartbeat();
          await vi.advanceTimersByTimeAsync(15_000);
        });
      }
      const server = fleetFromAutoscalerStatuses(
        projectAutoscalerStatuses(raw),
      );
      expect(server.online).toBeUndefined();
      expect(server.directExecutor).toBeDefined();
      expect(screen.getByTestId('fleet-chip')).toHaveTextContent(
        'GitHub runner status unavailable · Direct executor ready (limit 8)',
      );
      expect(screen.queryByTestId('metric-runner-occupancy')).toBeNull();
      expect(screen.getByTestId('live-dashboard-status').textContent).toMatch(
        stream === 'unchanged'
          ? /^Live updates connected$/
          : /stale|connecting/i,
      );
      expect(mocks.refresh).not.toHaveBeenCalled();
      // RSC re-delivery of the same producer snapshot must not renew its age.
      rendered.rerender(view(surface, fleet));
      expect(screen.getByTestId('fleet-chip')).toHaveTextContent(
        'GitHub runner status unavailable',
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(45_001);
      });
      expect(
        fleetFromAutoscalerStatuses(projectAutoscalerStatuses(raw)),
      ).toEqual({});
      expect(screen.getByTestId('fleet-chip')).toHaveTextContent(
        'GitHub runner status unavailable · Direct executor status unavailable',
      );
      // Only a genuinely fresh producer write restores capacity.
      rendered.rerender(
        view(
          surface,
          fleetFromAutoscalerStatuses(
            projectAutoscalerStatuses(records(Date.now())),
          ),
        ),
      );
      expect(screen.getByTestId('fleet-chip')).toHaveTextContent(
        '5 GitHub runners registered (2 running) · Direct executor ready (limit 8)',
      );
    },
  );

  it('keeps genuine zero visible through the inclusive deadline, then becomes unavailable', async () => {
    render(
      view(
        'Bridge',
        fleetFromAutoscalerStatuses(projectAutoscalerStatuses(records(T0, 0))),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(screen.getByTestId('fleet-chip')).toHaveTextContent(
      '0 GitHub runners registered (0 running)',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByTestId('fleet-chip')).toHaveTextContent(
      'GitHub runner status unavailable',
    );
    expect(screen.getByTestId('fleet-chip')).not.toHaveTextContent(
      '0 GitHub runners',
    );
  });

  it('expires an older direct executor without hiding still-fresh ARC capacity', async () => {
    const raw = records()
      .filter((record) => record['lane'] !== 'older-zero')
      .map((record) =>
        record.kind === 'queue-executor'
          ? { ...record, updatedAt: new Date(T0 - 60_000).toISOString() }
          : record,
      );
    render(
      view(
        'Agents',
        fleetFromAutoscalerStatuses(projectAutoscalerStatuses(raw)),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_001);
    });
    expect(screen.getByTestId('fleet-chip')).toHaveTextContent(
      '5 GitHub runners registered (2 running) · Direct executor status unavailable',
    );
    expect(screen.getByTestId('metric-runner-occupancy')).toHaveTextContent(
      '2/5 GitHub runners running',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByTestId('fleet-chip')).toHaveTextContent(
      'GitHub runner status unavailable · Direct executor status unavailable',
    );
    expect(screen.queryByTestId('metric-runner-occupancy')).toBeNull();
  });

  it('fails closed when projected counts lack a valid producer deadline', () => {
    render(
      <MantineProvider>
        <FleetChip
          fleet={{
            online: 0,
            busy: 0,
            githubExpiresAt: 'not-a-date',
            directExecutor: {
              ready: true,
              draining: false,
              maxConcurrent: 8,
              expiresAt: '',
            },
          }}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('fleet-chip')).toHaveTextContent(
      'GitHub runner status unavailable · Direct executor status unavailable',
    );
  });
});
