import { MantineProvider } from '@mantine/core';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RUNNER_STATUS_EVENT,
  RUNNER_STATUS_STALENESS_MS,
} from '../lib/runner-status-contract';
import {
  expireAutoscalerStatuses,
  RUNNER_STATUS_STREAM_URL,
  RunnerAutoscalerStatus,
} from './runner-autoscaler-status';

const lane = {
  schemaVersion: 3 as const,
  kind: 'arc-lane' as const,
  lane: 'lcars-ci',
  registrationUrl: 'https://github.com/jlapenna/agent-lcars',
  assignedJobs: 3,
  runningJobs: 1,
  pendingJobs: 2,
  idleRunners: 1,
  registeredRunners: 2,
  desiredRunners: 3,
  minRunners: 0,
  maxRunners: 4,
  updatedAt: '2026-10-03T01:00:00.000Z',
};
const executor = {
  schemaVersion: 2 as const,
  kind: 'queue-executor' as const,
  executor: 'queue' as const,
  ready: true,
  draining: false,
  maxConcurrent: 3,
  updatedAt: lane.updatedAt,
};

describe('RunnerAutoscalerStatus', () => {
  beforeEach(() => vi.stubGlobal('EventSource', FakeEventSource));
  afterEach(() => {
    FakeEventSource.instances = [];
    vi.unstubAllGlobals();
  });

  it('renders GitHub ARC lanes separately from direct agent Jobs', () => {
    render(
      <MantineProvider>
        <RunnerAutoscalerStatus
          initial={{
            lanes: [lane],
            queueExecutor: { ...executor, activeRuns: 5, draining: true },
            warnings: [],
          }}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('arc-lane-lcars-ci')).toHaveTextContent(
      '2 pending',
    );
    expect(screen.getByTestId('arc-lane-lcars-ci')).toHaveTextContent(
      '1 running',
    );
    expect(screen.getByRole('link', { name: 'lcars-ci' })).toHaveAttribute(
      'href',
      lane.registrationUrl,
    );
    expect(screen.getByTestId('queue-executor-status')).toHaveTextContent(
      'Direct agent executorreadydraining5 active · 3 max',
    );
  });

  it('distinguishes missing telemetry from fresh zero ARC capacity and unknown Job occupancy', () => {
    const { rerender } = render(
      <MantineProvider>
        <RunnerAutoscalerStatus initial={{ warnings: [] }} />
      </MantineProvider>,
    );
    expect(screen.getByText('GitHub runner status unavailable.')).toBeVisible();
    expect(
      screen.getByText('Direct executor status unavailable.'),
    ).toBeVisible();
    rerender(
      <MantineProvider>
        <RunnerAutoscalerStatus
          key="fresh"
          initial={{
            lanes: [
              {
                ...lane,
                assignedJobs: 0,
                runningJobs: 0,
                pendingJobs: 0,
                idleRunners: 0,
                registeredRunners: 0,
                desiredRunners: 0,
              },
            ],
            queueExecutor: executor,
            warnings: [],
          }}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('arc-lane-lcars-ci')).toHaveTextContent(
      '0 running · 0 idle · 0 registered',
    );
    expect(screen.getByTestId('queue-executor-status')).toHaveTextContent(
      'active unknown',
    );
    expect(screen.queryByText('GitHub runner status unavailable.')).toBeNull();
  });

  it('expires both contracts locally, preserving a fresh independent producer', () => {
    const now = Date.parse('2026-10-03T01:03:01.000Z');
    const fresh = '2026-10-03T01:00:30.000Z';
    const staleLane = expireAutoscalerStatuses(
      {
        lanes: [lane],
        queueExecutor: { ...executor, updatedAt: fresh },
        warnings: [],
      },
      now,
    );
    expect(staleLane.lanes).toEqual([]);
    expect(staleLane.queueExecutor).toBeDefined();
    const staleExecutor = expireAutoscalerStatuses(
      {
        lanes: [{ ...lane, updatedAt: fresh }],
        queueExecutor: executor,
        warnings: ['Unrelated warning.'],
      },
      now,
    );
    expect(staleExecutor.lanes).toHaveLength(1);
    expect(staleExecutor.queueExecutor).toBeUndefined();
    expect(staleExecutor.warnings).toEqual([
      'Unrelated warning.',
      'Runner capacity status is stale.',
    ]);
  });

  it('makes telemetry read failures visible', () => {
    render(
      <MantineProvider>
        <RunnerAutoscalerStatus
          initial={{ warnings: ['Runner status unavailable.'] }}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('data-warnings')).toHaveTextContent(
      'unavailable',
    );
  });

  it('applies pushed snapshots, keeps warnings in one live band, and closes the stream on unmount', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'));
    const queueExecutor = {
      schemaVersion: 2 as const,
      kind: 'queue-executor' as const,
      executor: 'queue' as const,
      ready: true,
      draining: false,
      maxConcurrent: 3,
      updatedAt: new Date().toISOString(),
    };
    const warning = 'ARC lane status is stale.';
    try {
      const { unmount } = render(
        <MantineProvider>
          <RunnerAutoscalerStatus
            initial={{ queueExecutor, warnings: [warning] }}
          />
        </MantineProvider>,
      );
      const source = FakeEventSource.only();
      expect(source.url).toBe(RUNNER_STATUS_STREAM_URL);
      expect(screen.getAllByText(warning)).toHaveLength(1);
      expect(
        screen
          .getByTestId('data-warnings')
          .closest('.console-workspace__warnings'),
      ).not.toBeNull();

      act(() =>
        source.push({
          queueExecutor: { ...queueExecutor, activeRuns: 2 },
          warnings: ['ARC status unavailable.'],
        }),
      );
      expect(screen.queryByText(warning)).not.toBeInTheDocument();
      expect(screen.getAllByText('ARC status unavailable.')).toHaveLength(1);
      expect(screen.getByTestId('queue-executor-status')).toHaveTextContent(
        '2 active',
      );

      act(() => source.push({ queueExecutor, warnings: [] }));
      expect(screen.queryByTestId('data-warnings')).not.toBeInTheDocument();

      // No event for longer than the staleness window: the producer stopped.
      act(() => {
        vi.advanceTimersByTime(RUNNER_STATUS_STALENESS_MS + 10_000);
      });
      expect(
        screen.queryByTestId('queue-executor-status'),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText('Runner capacity status is stale.'),
      ).toBeInTheDocument();

      unmount();
      expect(source.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reopens the stream after the browser gives up on an HTTP error, with backoff', () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(
        <MantineProvider>
          <RunnerAutoscalerStatus initial={{ warnings: [] }} />
        </MantineProvider>,
      );
      const first = FakeEventSource.only();

      first.failTransiently();
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(FakeEventSource.instances).toHaveLength(1);

      first.failPermanently();
      expect(first.closed).toBe(true);
      act(() => {
        vi.advanceTimersByTime(4_999);
      });
      expect(FakeEventSource.instances).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(FakeEventSource.instances).toHaveLength(2);

      const second = FakeEventSource.instances[1] as FakeEventSource;
      second.failPermanently();
      act(() => {
        vi.advanceTimersByTime(9_999);
      });
      expect(FakeEventSource.instances).toHaveLength(2);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(FakeEventSource.instances).toHaveLength(3);

      const third = FakeEventSource.instances[2] as FakeEventSource;
      third.failPermanently();
      unmount();
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(FakeEventSource.instances).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  static only(): FakeEventSource {
    if (FakeEventSource.instances.length !== 1) {
      throw new Error(
        `expected one EventSource, got ${FakeEventSource.instances.length}`,
      );
    }
    return FakeEventSource.instances[0] as FakeEventSource;
  }
  closed = false;
  readyState = FakeEventSource.OPEN;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, (event: MessageEvent) => void>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  /** What a browser does after a non-200 reconnect: closes for good. */
  failPermanently() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
  /** What a browser does on a dropped connection: retries by itself. */
  failTransiently() {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.();
  }
  push(result: unknown) {
    this.listeners.get(RUNNER_STATUS_EVENT)?.(
      new MessageEvent(RUNNER_STATUS_EVENT, { data: JSON.stringify(result) }),
    );
  }
}
