import { getAgentTelemetryReaderFirestore } from '@agent-lcars/telemetry/server';
import { Timestamp } from 'firebase-admin/firestore';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { getAutoscalerStatuses } from './autoscaler-status';

vi.mock('@agent-lcars/telemetry/server', () => ({
  getAgentTelemetryReaderFirestore: vi.fn(),
}));

function status(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    scaleSet: 'lcars-ci',
    registration: 'primary',
    queuedJobs: 2,
    minRunners: 0,
    maxRunners: 4,
    draining: false,
    runners: [
      { name: 'runner-idle', host: 'janeway', state: 'idle' },
      { name: 'runner-busy', host: 'spark', state: 'busy', jobId: 'job-42' },
    ],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockStore(docs: unknown[]) {
  (getAgentTelemetryReaderFirestore as Mock).mockResolvedValue({
    collection: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue({
        docs: docs.map((data) => ({ data: () => data })),
      }),
    }),
  });
}

describe('getAutoscalerStatuses', () => {
  afterEach(() => vi.resetAllMocks());

  it('returns fresh, schema-valid scale set snapshots', async () => {
    const firestoreOnlyFields = {
      expireAt: Timestamp.now(),
    };
    mockStore([
      status({
        ...firestoreOnlyFields,
        runners: [
          {
            name: 'runner-idle',
            host: 'janeway',
            state: 'idle',
            firestoreMetadata: firestoreOnlyFields,
          },
          {
            name: 'runner-busy',
            host: 'spark',
            state: 'busy',
            jobId: 'job-42',
          },
        ],
      }),
    ]);

    const result = await getAutoscalerStatuses();

    expect(result.warnings).toEqual([]);
    expect(result.statuses).toEqual([
      {
        schemaVersion: 1,
        scaleSet: 'lcars-ci',
        registration: 'primary',
        queuedJobs: 2,
        minRunners: 0,
        maxRunners: 4,
        draining: false,
        runners: [
          { name: 'runner-idle', host: 'janeway', state: 'idle' },
          {
            name: 'runner-busy',
            host: 'spark',
            state: 'busy',
            jobId: 'job-42',
          },
        ],
        updatedAt: expect.any(String),
      },
    ]);
  });

  it('drops stale or malformed registrations instead of presenting them as live', async () => {
    mockStore([
      status({ updatedAt: new Date(Date.now() - 31_000).toISOString() }),
      status({ schemaVersion: 2 }),
      status({ runners: [{ name: 'bad', host: 'spark', state: 'unknown' }] }),
    ]);

    expect((await getAutoscalerStatuses()).statuses).toEqual([]);
  });

  it('degrades without throwing when telemetry reads fail', async () => {
    (getAgentTelemetryReaderFirestore as Mock).mockRejectedValue(
      new Error('offline'),
    );

    const result = await getAutoscalerStatuses();

    expect(result.statuses).toEqual([]);
    expect(result.warnings[0]).toContain('unavailable');
  });
});
