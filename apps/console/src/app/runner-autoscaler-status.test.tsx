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
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(lane.updatedAt));
  });
  afterEach(() => {
    FakeEventSource.instances = [];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders quota provenance, exact recent claims, drain and unavailable updates', () => {
    const now = new Date(Date.now()).toISOString();
    const reset = new Date(Date.now() + 60_000).toISOString();
    const executor = {
      schemaVersion: 2 as const,
      kind: 'queue-executor' as const,
      executor: 'queue' as const,
      ready: true,
      draining: false,
      activeRuns: 0,
      maxConcurrent: 3,
      updatedAt: now,
      claims: {
        claude: 3,
        codex: 0,
        opencode: 1,
        windowStart: new Date(Date.now() - 60_000).toISOString(),
        windowEnd: now,
      },
    };
    const providerAdmission = {
      observedAt: now,
      provenance: 'orchestrator' as const,
      providers: [
        {
          pipeline: 'claude',
          queued: 2,
          deferred: 0,
          eligible: 0,
          liveClaims: 0,
          cooldown: {
            pipeline: 'claude',
            runId: 'quota/r1',
            observedAt: now,
            expiresAt: reset,
          },
        },
        {
          pipeline: 'codex',
          queued: 1,
          deferred: 0,
          eligible: 1,
          liveClaims: 0,
        },
      ],
    };
    render(
      <MantineProvider>
        <RunnerAutoscalerStatus
          initial={{
            warnings: [],
            queueExecutor: executor,
            providerAdmission,
          }}
        />
      </MantineProvider>,
    );
    const claude = screen.getByTestId('provider-admission-claude');
    const codex = screen.getByTestId('provider-admission-codex');
    expect(claude).toHaveTextContent('cooling down');
    expect(claude).toHaveTextContent(reset);
    expect(claude).toHaveTextContent('quota/r1');
    expect(claude).toHaveTextContent('3 claims from');
    expect(codex).toHaveTextContent('1 eligible queued');
    expect(codex).toHaveTextContent('0 claims from');
    act(() =>
      FakeEventSource.only().push({
        warnings: [],
        queueExecutor: { ...executor, draining: true },
        providerAdmission,
      }),
    );
    expect(codex).toHaveTextContent('executor draining');
    expect(codex).toHaveTextContent('0 eligible queued');
    expect(codex).toHaveTextContent('1 queued');
    act(() =>
      FakeEventSource.only().push({
        warnings: [],
        providerAdmission,
      }),
    );
    expect(codex).toHaveTextContent('Eligible queue unavailable');
    expect(codex).toHaveTextContent('Recent claims unavailable');
    act(() => FakeEventSource.only().push({ warnings: [] }));
    expect(codex).toHaveTextContent('admission unavailable');
    expect(codex).not.toHaveTextContent('0 eligible queued');
  });

  it('invalidates pre-reset eligibility at the deadline and retains independent evidence until stale', () => {
    const now = '2026-10-09T23:00:00.000Z';
    const result = {
      warnings: [],
      providerAdmission: {
        observedAt: now,
        provenance: 'orchestrator' as const,
        providers: [
          {
            pipeline: 'claude',
            queued: 2,
            deferred: 0,
            eligible: 0,
            liveClaims: 0,
            cooldown: {
              pipeline: 'claude',
              runId: 'quota/r1',
              observedAt: now,
              expiresAt: '2026-10-09T23:01:00.000Z',
            },
          },
        ],
      },
    };
    expect(
      expireAutoscalerStatuses(result, Date.parse('2026-10-09T23:00:59.000Z')),
    ).toBe(result);
    expect(
      expireAutoscalerStatuses(result, Date.parse('2026-10-09T23:01:00.000Z'))
        .providerAdmission,
    ).toBeUndefined();
    const expiredCooldown = {
      ...result,
      providerAdmission: {
        ...result.providerAdmission,
        observedAt: '2026-10-09T23:01:01.000Z',
        providers: [{ ...result.providerAdmission.providers[0], eligible: 2 }],
      },
    };
    expect(
      expireAutoscalerStatuses(
        expiredCooldown,
        Date.parse('2026-10-09T23:01:02.000Z'),
      ).providerAdmission,
    ).toBeDefined();
    expect(
      expireAutoscalerStatuses(
        expiredCooldown,
        Date.parse('2026-10-09T23:04:02.000Z'),
      ).providerAdmission,
    ).toBeUndefined();
  });

  it('rejects expired-on-arrival cooldown counts in both first paint and streamed frames', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-09T23:00:05.000Z'));
      const provider = {
        pipeline: 'claude',
        queued: 2,
        deferred: 0,
        eligible: 0,
        liveClaims: 0,
        cooldown: {
          pipeline: 'claude',
          runId: 'quota/r1',
          observedAt: '2026-10-09T23:00:00.000Z',
          expiresAt: '2026-10-09T23:00:04.000Z',
        },
      };
      const old = {
        warnings: [],
        providerAdmission: {
          observedAt: '2026-10-09T23:00:00.000Z',
          provenance: 'orchestrator' as const,
          providers: [provider],
        },
      };
      render(
        <MantineProvider>
          <RunnerAutoscalerStatus initial={old} />
        </MantineProvider>,
      );
      const row = screen.getByTestId('provider-admission-claude');
      expect(row).toHaveTextContent('admission unavailable');
      expect(row).not.toHaveTextContent('no active cooldown');
      expect(row).not.toHaveTextContent('0 eligible queued');
      act(() =>
        FakeEventSource.only().push({
          ...old,
          providerAdmission: {
            ...old.providerAdmission,
            observedAt: new Date().toISOString(),
            providers: [{ ...provider, eligible: 2 }],
          },
        }),
      );
      expect(row).toHaveTextContent('no active cooldown');
      act(() => FakeEventSource.only().push(old));
      expect(row).toHaveTextContent('admission unavailable');
      expect(row).not.toHaveTextContent('no active cooldown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves incomplete ARC inventory while provider evidence expires independently', () => {
    const observedAt = lane.updatedAt;
    const admission = {
      observedAt,
      provenance: 'orchestrator' as const,
      providers: [
        {
          pipeline: 'claude',
          queued: 2,
          deferred: 0,
          eligible: 0,
          liveClaims: 0,
          cooldown: {
            pipeline: 'claude',
            runId: 'quota/r1',
            observedAt,
            expiresAt: '2026-10-03T01:01:00.000Z',
          },
        },
      ],
    };
    const result = expireAutoscalerStatuses(
      {
        lanes: [lane],
        lanesIncomplete: true,
        queueExecutor: executor,
        providerAdmission: admission,
        warnings: ['Configured ARC lane status is missing.'],
      },
      Date.parse('2026-10-03T01:01:00.000Z'),
    );
    expect(result.providerAdmission).toBeUndefined();
    expect(result.queueExecutor).toEqual(executor);
    expect(result.lanes).toEqual([lane]);
    expect(result.lanesIncomplete).toBe(true);
    expect(result.warnings).toContain('Configured ARC lane status is missing.');
    const later = expireAutoscalerStatuses(
      {
        lanes: [lane],
        providerAdmission: {
          ...admission,
          observedAt: '2026-10-03T01:03:01.000Z',
          providers: [],
        },
        warnings: [],
      },
      Date.parse('2026-10-03T01:03:01.000Z'),
    );
    expect(later.lanes).toEqual([]);
    expect(later.lanesIncomplete).toBe(true);
    expect(later.providerAdmission).toBeDefined();
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
