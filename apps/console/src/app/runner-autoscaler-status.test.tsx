import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  expireAutoscalerStatuses,
  RunnerAutoscalerStatus,
} from './runner-autoscaler-status';

describe('RunnerAutoscalerStatus', () => {
  it('expires a cached status locally when polling cannot refresh it', () => {
    const result = expireAutoscalerStatuses(
      {
        warnings: [],
        statuses: [
          {
            schemaVersion: 1,
            scaleSet: 'lcars-ci',
            registration: 'primary',
            queuedJobs: 1,
            minRunners: 0,
            maxRunners: 1,
            draining: false,
            updatedAt: '2026-08-09T04:00:00.000Z',
            runners: [],
          },
        ],
      },
      Date.parse('2026-08-09T04:00:31.000Z'),
    );

    expect(result.statuses).toEqual([]);
    expect(result.warnings[0]).toContain('stale');
  });

  it('renders queued, busy, idle, and job status for a registered scale set', () => {
    render(
      <MantineProvider>
        <RunnerAutoscalerStatus
          initial={{
            warnings: [],
            statuses: [
              {
                schemaVersion: 1,
                scaleSet: 'lcars-ci',
                registration: 'primary',
                queuedJobs: 2,
                minRunners: 0,
                maxRunners: 4,
                draining: false,
                updatedAt: new Date().toISOString(),
                runners: [
                  { name: 'runner-a', host: 'janeway', state: 'idle' },
                  {
                    name: 'runner-b',
                    host: 'spark',
                    state: 'busy',
                    jobId: 'job-42',
                  },
                ],
              },
            ],
          }}
        />
      </MantineProvider>,
    );

    expect(
      screen.getByTestId('autoscaler-scale-set-lcars-ci'),
    ).toHaveTextContent('2 queued · 1 busy · 1 idle · 4 max');
    expect(screen.getByText(/runner-b \(job-42\)/)).toBeTruthy();
  });

  it('makes a telemetry read failure visible without adding empty panel chrome', () => {
    render(
      <MantineProvider>
        <RunnerAutoscalerStatus
          initial={{
            statuses: [],
            warnings: ['Runner autoscaler status unavailable.'],
          }}
        />
      </MantineProvider>,
    );

    expect(
      screen.getByTestId('runner-autoscaler-status-warning'),
    ).toHaveTextContent('unavailable');
  });
});
