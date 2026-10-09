import { getAgentTelemetryReaderFirestore } from '@agent-lcars/telemetry/server';
import { Timestamp } from 'firebase-admin/firestore';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
  getAutoscalerStatuses,
  subscribeAutoscalerStatuses,
} from './autoscaler-status';

vi.mock('@agent-lcars/telemetry/server', () => ({
  forClient: vi.fn((value: unknown) => value),
  getAgentTelemetryReaderFirestore: vi.fn(),
}));

function status(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    scaleSet: 'lcars-ci',
    registration: 'primary',
    registrationUrl: 'https://github.com/jlapenna/agent-lcars',
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

  it('reads fresh ARC capacity without leaking Firestore metadata, rejecting uncertain counts', async () => {
    const lane = {
      schemaVersion: 3,
      kind: 'arc-lane',
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
      updatedAt: new Date().toISOString(),
    };
    mockStore([
      { ...lane, expireAt: Timestamp.now() },
      {
        ...lane,
        lane: 'stale',
        updatedAt: new Date(Date.now() - 181_000).toISOString(),
      },
      { ...lane, lane: 'bad', runningJobs: NaN },
      { ...lane, lane: 'unsafe', registrationUrl: 'javascript:alert(1)' },
    ]);
    const result = await getAutoscalerStatuses();
    expect(result.lanes).toEqual([lane]);
    expect(result.statuses).toEqual([]);
    expect(result.warnings).toEqual(['ARC lane status is stale.']);
  });

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
        registrationUrl: 'https://github.com/jlapenna/agent-lcars',
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
      status({ updatedAt: new Date(Date.now() - 181_000).toISOString() }),
      status({ schemaVersion: 2 }),
      status({ runners: [{ name: 'bad', host: 'spark', state: 'unknown' }] }),
    ]);

    expect((await getAutoscalerStatuses()).statuses).toEqual([]);
  });

  it('parses the additive queue-executor health record without treating it as scale-set capacity', async () => {
    mockStore([
      status(),
      {
        schemaVersion: 2,
        kind: 'queue-executor',
        executor: 'queue',
        ready: true,
        draining: false,
        activeRuns: 2,
        maxConcurrent: 3,
        updatedAt: new Date().toISOString(),
      },
    ]);

    const result = await getAutoscalerStatuses();

    expect(result.statuses).toHaveLength(1);
    expect(result.queueExecutor).toEqual({
      schemaVersion: 2,
      kind: 'queue-executor',
      executor: 'queue',
      ready: true,
      draining: false,
      activeRuns: 2,
      maxConcurrent: 3,
      updatedAt: expect.any(String),
    });
  });

  it('degrades without throwing when telemetry reads fail', async () => {
    (getAgentTelemetryReaderFirestore as Mock).mockRejectedValue(
      new Error('offline'),
    );

    const result = await getAutoscalerStatuses();

    expect(result.statuses).toEqual([]);
    expect(result.warnings[0]).toContain('unavailable');
  });

  it('validates the exact bounded claim window and strips producer-only metadata', async () => {
    const now = new Date().toISOString();
    const claims = {
      claude: 3,
      codex: 0,
      opencode: 1,
      windowStart: new Date(Date.now() - 60_000).toISOString(),
      windowEnd: now,
    };
    const executor = {
      schemaVersion: 2,
      kind: 'queue-executor',
      executor: 'queue',
      ready: true,
      draining: false,
      maxConcurrent: 3,
      updatedAt: now,
    };
    mockStore([
      { ...executor, claims: { ...claims, expireAt: Timestamp.now() } },
    ]);
    expect((await getAutoscalerStatuses()).queueExecutor?.claims).toEqual(
      claims,
    );
    for (const invalid of [
      { ...claims, claude: -1 },
      { ...claims, codex: 0.5 },
      { ...claims, windowEnd: 'invalid' },
      {
        ...claims,
        windowStart: new Date(Date.now() - 16 * 60_000).toISOString(),
      },
    ]) {
      mockStore([{ ...executor, claims: invalid }]);
      const result = await getAutoscalerStatuses();
      expect(result.queueExecutor?.ready).toBe(true);
      expect(result.queueExecutor?.claims).toBeUndefined();
    }
  });
});

describe('subscribeAutoscalerStatuses', () => {
  afterEach(() => vi.resetAllMocks());

  function mockListener() {
    const unsubscribe = vi.fn();
    const onSnapshot = vi.fn().mockReturnValue(unsubscribe);
    (getAgentTelemetryReaderFirestore as Mock).mockResolvedValue({
      collection: vi.fn().mockReturnValue({ onSnapshot }),
    });
    const emit = (docs: unknown[]) =>
      (onSnapshot.mock.calls[0]?.[0] as (snapshot: unknown) => void)({
        docs: docs.map((data) => ({ data: () => data })),
      });
    const fail = (error: Error) =>
      (onSnapshot.mock.calls[0]?.[1] as (error: Error) => void)(error);
    return { unsubscribe, emit, fail };
  }

  it('projects every pushed snapshot and hands back the unsubscribe', async () => {
    const { unsubscribe, emit } = mockListener();
    const results: unknown[] = [];

    const stop = await subscribeAutoscalerStatuses((result) =>
      results.push(result),
    );
    emit([status({ expireAt: Timestamp.now() })]);
    emit([status({ queuedJobs: 5 })]);

    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ statuses: [{ queuedJobs: 5 }] });
    expect(JSON.stringify(results[0])).not.toContain('expireAt');
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('reports a listener error as unavailable instead of throwing', async () => {
    const { fail } = mockListener();
    const onResult = vi.fn();

    await subscribeAutoscalerStatuses(onResult);
    fail(new Error('permission denied'));

    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        warnings: [expect.stringContaining('unavailable')],
      }),
    );
  });

  it('reports a reader failure as unavailable and never rejects', async () => {
    (getAgentTelemetryReaderFirestore as Mock).mockRejectedValue(
      new Error('offline'),
    );
    const onResult = vi.fn();

    const stop = await subscribeAutoscalerStatuses(onResult);

    expect(onResult).toHaveBeenCalledOnce();
    expect(() => stop()).not.toThrow();
  });
});
