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
    expect(
      screen
        .getByTestId('fleet-telemetry')
        .textContent?.match(/no metrics source/g),
    ).toHaveLength(1);
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
});
