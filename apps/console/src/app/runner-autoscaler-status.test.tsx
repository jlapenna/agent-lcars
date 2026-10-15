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

  it('says a filter, not missing data, emptied the runner views', () => {
    render(
      <MantineProvider>
        <RunnerAutoscalerStatus
          initial={{ warnings: [], lanes: [lane], queueExecutor: executor }}
          filters={{ q: 'nomatch' }}
        />
      </MantineProvider>,
    );
    expect(
      screen.getAllByText('No runner lane matches these filters.'),
    ).toHaveLength(2);
    expect(screen.queryByText('Direct agent executor')).toBeNull();
    expect(screen.queryByText('GitHub runner status unavailable.')).toBeNull();
    expect(screen.queryByText('Runner status unavailable')).toBeNull();
  });

  it('does not call an empty filter conclusive while lanes are missing', () => {
    render(
      <MantineProvider>
        <RunnerAutoscalerStatus
          initial={{
            warnings: [],
            lanes: [lane],
            lanesIncomplete: true,
            queueExecutor: executor,
          }}
          filters={{ q: 'nomatch' }}
        />
      </MantineProvider>,
    );
    expect(
      screen.getByText(
        'No reporting lane matches these filters; some lanes are not reporting.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Runner status unavailable')).toBeTruthy();
    expect(
      screen.queryByText('No runner lane matches these filters.'),
    ).toBeNull();
  });

  it('narrows admission to the filtered agent', () => {
    render(
      <MantineProvider>
        <RunnerAutoscalerStatus
          initial={{ warnings: [], lanes: [lane], queueExecutor: executor }}
          filters={{ agent: 'codex' }}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('provider-admission-codex')).toBeTruthy();
    expect(screen.queryByTestId('provider-admission-claude')).toBeNull();
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
    expect(
      screen.getByRole('link', { name: 'lcars-ci on GitHub ↗' }),
    ).toHaveAttribute('href', lane.registrationUrl);
    const executorRow = screen.getByTestId('queue-executor-status');
    expect(executorRow).toHaveTextContent('Direct agent executor');
    expect(executorRow).toHaveTextContent('ready · draining');
    expect(executorRow).toHaveTextContent('5 active · 3 max');
  });

  it('draws one row per runner pod once the executor publishes them', () => {
    const hostInventory = {
      hosts: [
        {
          name: 'spark',
          ready: true,
          unschedulable: false,
          cpuMillis: 20_000,
          memoryBytes: 128 * 1024 ** 3,
          requestedCpuMillis: 6_000,
          requestedMemoryBytes: 16 * 1024 ** 3,
          runnerPods: 2,
          queueJobPods: 1,
        },
      ],
      runners: [
        {
          name: 'lcars-ci-x1',
          kind: 'arc' as const,
          lane: 'lcars-ci',
          host: 'spark',
          state: 'busy' as const,
          since: lane.updatedAt,
          requestedCpuMillis: 4_000,
          requestedMemoryBytes: 12 * 1024 ** 3,
          jobRepository: 'jlapenna/agent-lcars',
          jobName: 'Verify',
          workflowRunId: 9001,
        },
        {
          name: 'lcars-ci-x2',
          kind: 'arc' as const,
          lane: 'lcars-ci',
          host: 'spark',
          state: 'idle' as const,
          since: lane.updatedAt,
          requestedCpuMillis: 0,
          requestedMemoryBytes: 0,
        },
        {
          name: 'lcars-run-1',
          kind: 'direct' as const,
          lane: 'direct',
          host: 'worf',
          state: 'offline' as const,
          since: lane.updatedAt,
          requestedCpuMillis: 2_000,
          requestedMemoryBytes: 4 * 1024 ** 3,
          runId: 'run-1',
          work: {
            label: 'agent-lcars#2479',
            href: '/task/jlapenna/agent-lcars/2479',
            repo: 'jlapenna/agent-lcars',
            pipeline: 'claude',
          },
        },
      ],
      runnerJobsKnown: true,
      updatedAt: lane.updatedAt,
    };
    const { rerender } = render(
      <MantineProvider>
        <RunnerAutoscalerStatus
          initial={{ lanes: [lane], hostInventory, warnings: [] }}
        />
      </MantineProvider>,
    );
    const panel = screen.getByTestId('shuttlebay-runners');
    expect(panel).toHaveTextContent('2/3 online');
    expect(panel).toHaveTextContent('every job fits one host after reserves');
    expect(screen.queryByTestId('arc-lane-lcars-ci')).toBeNull();
    expect(
      screen.getByRole('link', { name: 'agent-lcars · Verify ↗' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/jlapenna/agent-lcars/actions/runs/9001',
    );
    expect(screen.getByTestId('runner-lcars-ci-x1')).toHaveTextContent(
      '4c/12G',
    );
    expect(screen.getByTestId('runner-lcars-ci-x2')).toHaveTextContent('Idle');
    const direct = screen.getByTestId('runner-lcars-run-1');
    expect(direct).toHaveTextContent('Offline');
    expect(
      screen.getByRole('link', { name: 'agent-lcars#2479' }),
    ).toHaveAttribute('href', '/task/jlapenna/agent-lcars/2479');

    rerender(
      <MantineProvider>
        <RunnerAutoscalerStatus
          initial={{ lanes: [lane], hostInventory, warnings: [] }}
          filters={{ agent: 'codex' }}
        />
      </MantineProvider>,
    );
    // The live island keeps its first snapshot; filters narrow it, count too.
    expect(screen.queryByTestId('runner-lcars-run-1')).toBeNull();
    expect(screen.getByTestId('shuttlebay-runners')).toHaveTextContent(
      '2/2 online',
    );
    expect(screen.getByTestId('runner-lcars-ci-x1')).toBeInTheDocument();
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
      // One band: the warning appears inline in its summary and in the
      // expanded list of that same band, never in a second band.
      expect(screen.getAllByTestId('data-warnings')).toHaveLength(1);
      expect(screen.getByTestId('data-warnings')).toHaveTextContent(warning);
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
      expect(screen.getByTestId('data-warnings')).not.toHaveTextContent(
        warning,
      );
      expect(screen.getAllByTestId('data-warnings')).toHaveLength(1);
      expect(screen.getByTestId('data-warnings')).toHaveTextContent(
        'ARC status unavailable.',
      );
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
      expect(screen.getByTestId('data-warnings')).toHaveTextContent(
        'Runner capacity status is stale.',
      );

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
