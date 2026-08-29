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

  it('keeps a fresh queue executor visible when v1 scale-set rows are stale', () => {
    const result = expireAutoscalerStatuses(
      {
        warnings: [],
        statuses: [
          {
            schemaVersion: 1,
            scaleSet: 'lcars-ci',
            registration: 'primary',
            queuedJobs: 0,
            minRunners: 0,
            maxRunners: 1,
            draining: false,
            updatedAt: '2026-08-09T04:00:00.000Z',
            runners: [],
          },
        ],
        queueExecutor: {
          schemaVersion: 2,
          kind: 'queue-executor',
          executor: 'queue',
          ready: true,
          draining: false,
          activeRuns: 1,
          maxConcurrent: 3,
          updatedAt: '2026-08-09T04:00:30.000Z',
        },
      },
      Date.parse('2026-08-09T04:00:31.000Z'),
    );

    expect(result.statuses).toEqual([]);
    expect(result.queueExecutor).toMatchObject({ ready: true, activeRuns: 1 });
  });

  it('expires a stale queue executor even without scale-set telemetry', () => {
    const result = expireAutoscalerStatuses(
      {
        warnings: ['An unrelated telemetry warning.'],
        statuses: [],
        queueExecutor: {
          schemaVersion: 2,
          kind: 'queue-executor',
          executor: 'queue',
          ready: true,
          draining: false,
          maxConcurrent: 3,
          updatedAt: '2026-08-09T04:00:00.000Z',
        },
      },
      Date.parse('2026-08-09T04:00:31.000Z'),
    );

    expect(result.queueExecutor).toBeUndefined();
    expect(result.warnings).toEqual([
      'An unrelated telemetry warning.',
      'Runner autoscaler status is stale.',
    ]);
  });

  it('expires a stale queue executor without dropping fresh v1 scale-set telemetry', () => {
    const result = expireAutoscalerStatuses(
      {
        warnings: [],
        statuses: [
          {
            schemaVersion: 1,
            scaleSet: 'lcars-ci',
            registration: 'primary',
            queuedJobs: 0,
            minRunners: 0,
            maxRunners: 1,
            draining: false,
            updatedAt: '2026-08-09T04:00:30.000Z',
            runners: [],
          },
        ],
        queueExecutor: {
          schemaVersion: 2,
          kind: 'queue-executor',
          executor: 'queue',
          ready: true,
          draining: false,
          maxConcurrent: 3,
          updatedAt: '2026-08-09T04:00:00.000Z',
        },
      },
      Date.parse('2026-08-09T04:00:31.000Z'),
    );

    expect(result.statuses).toHaveLength(1);
    expect(result.queueExecutor).toBeUndefined();
  });

  it('renders direct queue health without any v1 scale-set rows', () => {
    render(
      <MantineProvider>
        <RunnerAutoscalerStatus
          initial={{
            warnings: [],
            statuses: [],
            queueExecutor: {
              schemaVersion: 2,
              kind: 'queue-executor',
              executor: 'queue',
              ready: true,
              draining: true,
              activeRuns: 2,
              maxConcurrent: 3,
              updatedAt: new Date().toISOString(),
            },
          }}
        />
      </MantineProvider>,
    );

    expect(screen.getByTestId('queue-executor-status')).toHaveTextContent(
      'Queue executorreadydraining2 active · 3 max',
    );
  });

  it('does not misrepresent an omitted active-run count as zero', () => {
    render(
      <MantineProvider>
        <RunnerAutoscalerStatus
          initial={{
            warnings: [],
            statuses: [],
            queueExecutor: {
              schemaVersion: 2,
              kind: 'queue-executor',
              executor: 'queue',
              ready: true,
              draining: false,
              maxConcurrent: 3,
              updatedAt: new Date().toISOString(),
            },
          }}
        />
      </MantineProvider>,
    );

    expect(screen.getByTestId('queue-executor-status')).toHaveTextContent(
      'active unknown · 3 max',
    );
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
                registrationUrl: 'https://github.com/jlapenna/agent-lcars',
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
    expect(
      screen.getByTestId('autoscaler-registration-lcars-ci'),
    ).toHaveAttribute('href', 'https://github.com/jlapenna/agent-lcars');
    expect(screen.getByTestId('autoscaler-runner-runner-b')).toHaveTextContent(
      'runner-b on spark · job-42',
    );
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
