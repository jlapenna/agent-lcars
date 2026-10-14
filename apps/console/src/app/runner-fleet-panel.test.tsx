import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RunnerFleetPanel } from './runner-fleet-panel';

const lane = {
  schemaVersion: 3 as const,
  kind: 'arc-lane' as const,
  lane: 'lcars-ci',
  registrationUrl: 'https://github.com/jlapenna/agent-lcars',
  assignedJobs: 1,
  runningJobs: 1,
  pendingJobs: 0,
  idleRunners: 1,
  registeredRunners: 2,
  desiredRunners: 2,
  minRunners: 0,
  updatedAt: '2026-10-13T15:00:00.000Z',
};

describe('RunnerFleetPanel', () => {
  it('shows an unbounded lane as having no maximum', () => {
    render(
      <MantineProvider>
        <RunnerFleetPanel lanes={[lane]} />
      </MantineProvider>,
    );
    expect(screen.getByText(/no max/)).toBeTruthy();
    expect(screen.getByTestId('runner-fleet-panel').textContent).toContain('2');
    expect(
      screen.getByTestId('fleet-lane-lcars-ci').querySelectorAll('i'),
    ).toHaveLength(2);
  });

  it('draws a bounded number of slots however large the maximum', () => {
    render(
      <MantineProvider>
        <RunnerFleetPanel lanes={[{ ...lane, maxRunners: 2_000_000_000 }]} />
      </MantineProvider>,
    );
    expect(
      screen.getByTestId('fleet-lane-lcars-ci').querySelectorAll('i'),
    ).toHaveLength(24);
  });

  it('shows CI wait p50 from the lanes and keeps unknown metrics unavailable', () => {
    const endedAt = '2026-10-13T15:00:00.000Z';
    render(
      <MantineProvider>
        <RunnerFleetPanel
          lanes={[
            {
              ...lane,
              jobStartup: {
                bounds: [10, 60],
                startedAt: '2026-10-13T14:48:00.000Z',
                endedAt,
                minutes: [{ endedAt, jobs: [[1, 3]] }],
              },
            },
          ]}
        />
      </MantineProvider>,
    );
    const ciWait = screen.getByTestId('fleet-ci-wait');
    expect(ciWait.textContent).toContain('35s');
    expect(ciWait.textContent).toContain('3 jobs · 12m');
    expect(ciWait.querySelectorAll('rect')).toHaveLength(1);
    expect(screen.getByTestId('fleet-work-api').textContent).toContain(
      'no executor latency data',
    );
  });

  it('shows CI wait as unavailable when no lane reports job starts', () => {
    render(
      <MantineProvider>
        <RunnerFleetPanel lanes={[lane]} />
      </MantineProvider>,
    );
    expect(screen.getByTestId('fleet-ci-wait').textContent).toContain(
      'no job-startup data',
    );
  });

  it('shows tokens per minute with its sparkline, or why it is unknown', () => {
    const { unmount } = render(
      <MantineProvider>
        <RunnerFleetPanel
          lanes={[lane]}
          tokenRate={{
            perMinute: 48_200,
            series: Array<number>(30).fill(48_200),
            sessions: 3,
            partial: true,
            observedAt: '2026-10-13T15:00:00.000Z',
          }}
        />
      </MantineProvider>,
    );
    const rate = screen.getByTestId('fleet-token-rate');
    expect(rate.textContent).toContain('48.2k');
    expect(rate.textContent).toContain('5m avg · 3 sessions · partial');
    expect(rate.querySelectorAll('rect')).toHaveLength(30);
    unmount();
    render(
      <MantineProvider>
        <RunnerFleetPanel
          lanes={[lane]}
          tokenRate={{ unavailable: 'no per-minute data' }}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('fleet-token-rate').textContent).toContain(
      'no per-minute data',
    );
  });

  it('shows the executor Work API p95 with its call count', () => {
    const endedAt = '2026-10-13T15:00:00.000Z';
    render(
      <MantineProvider>
        <RunnerFleetPanel
          lanes={[lane]}
          workApiLatency={{
            bounds: [0.1, 0.3, 1],
            startedAt: '2026-10-13T14:30:00.000Z',
            endedAt,
            minutes: [
              {
                endedAt,
                jobs: [
                  [0, 18],
                  [1, 2],
                ],
              },
            ],
          }}
        />
      </MantineProvider>,
    );
    const workApi = screen.getByTestId('fleet-work-api');
    // 20 calls: rank 19 lies in (0.1, 0.3], which holds calls 19 and 20.
    expect(workApi.textContent).toContain('200 ms');
    expect(workApi.textContent).toContain('20 calls · 30m');
    expect(workApi.querySelectorAll('rect')).toHaveLength(1);
  });

  it('draws one row per host with requested CPU and memory', () => {
    const host = {
      name: 'spark',
      ready: true,
      unschedulable: false,
      cpuMillis: 20_000,
      memoryBytes: 128 * 1024 ** 3,
      requestedCpuMillis: 17_000,
      requestedMemoryBytes: 32 * 1024 ** 3,
      runnerPods: 2,
      queueJobPods: 1,
    };
    render(
      <MantineProvider>
        <RunnerFleetPanel
          lanes={[lane]}
          hostInventory={{
            hosts: [
              host,
              {
                ...host,
                name: 'worf',
                ready: false,
                runnerPods: 0,
                queueJobPods: 0,
              },
            ],
            updatedAt: '2026-10-13T15:00:00.000Z',
          }}
        />
      </MantineProvider>,
    );
    const spark = screen.getByTestId('fleet-host-spark');
    expect(spark.textContent).toContain('20 vCPU · 128 GiB');
    expect(spark.textContent).toContain('85%');
    expect(spark.textContent).toContain('25%');
    expect(
      spark.querySelectorAll('.ops-slots i[data-state="pod"]'),
    ).toHaveLength(3);
    expect(
      spark.querySelector('[aria-label="2 runner pods, 1 queue job pod"]'),
    ).toBeTruthy();
    expect(spark.querySelector('[data-tone="warn"]')).toBeTruthy();
    expect(screen.getByTestId('fleet-host-worf').textContent).toContain(
      'NotReady',
    );
    expect(screen.queryByTestId('fleet-lane-lcars-ci')).toBeNull();
    expect(screen.getByText('Load · requested')).toBeTruthy();
  });

  it('meters live usage where metrics-server sampled the host', () => {
    const host = {
      name: 'spark',
      ready: true,
      unschedulable: false,
      cpuMillis: 20_000,
      memoryBytes: 128 * 1024 ** 3,
      requestedCpuMillis: 17_000,
      requestedMemoryBytes: 32 * 1024 ** 3,
      runnerPods: 0,
      queueJobPods: 0,
    };
    const sampled = {
      ...host,
      usedCpuMillis: 5_000,
      usedMemoryBytes: 96 * 1024 ** 3,
    };
    const { rerender } = render(
      <MantineProvider>
        <RunnerFleetPanel
          hostInventory={{
            hosts: [sampled, { ...host, name: 'worf', ready: false }],
            updatedAt: '2026-10-13T15:00:00.000Z',
          }}
        />
      </MantineProvider>,
    );
    const spark = screen.getByTestId('fleet-host-spark');
    expect(spark.textContent).toContain('25%');
    expect(spark.textContent).toContain('75%');
    expect(
      spark.querySelector('[aria-label="CPU used on spark"]'),
    ).toBeTruthy();
    // A NotReady host draws no meters, so it does not turn the column mixed.
    expect(screen.getByText('Load · used')).toBeTruthy();

    rerender(
      <MantineProvider>
        <RunnerFleetPanel
          hostInventory={{
            hosts: [sampled, { ...host, name: 'worf' }],
            updatedAt: '2026-10-13T15:00:00.000Z',
          }}
        />
      </MantineProvider>,
    );
    expect(screen.getByText('Load · used or requested')).toBeTruthy();
    expect(
      screen
        .getByTestId('fleet-host-worf')
        .querySelector('[aria-label="CPU requested on worf"]'),
    ).toBeTruthy();
  });

  it('never claims runner status is unavailable beside known hosts', () => {
    render(
      <MantineProvider>
        <RunnerFleetPanel
          hostInventory={{
            hosts: [
              {
                name: 'spark',
                ready: true,
                unschedulable: true,
                cpuMillis: 8_000,
                memoryBytes: 16 * 1024 ** 3,
                requestedCpuMillis: 0,
                requestedMemoryBytes: 0,
                runnerPods: 0,
                queueJobPods: 0,
              },
            ],
            updatedAt: '2026-10-13T15:00:00.000Z',
          }}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('fleet-host-spark').textContent).toContain(
      'draining',
    );
    expect(screen.queryByText('Runner status unavailable')).toBeNull();
  });
});
