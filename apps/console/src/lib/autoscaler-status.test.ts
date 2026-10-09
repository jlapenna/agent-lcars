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
    schemaVersion: 2,
    kind: 'queue-executor',
    executor: 'queue',
    ready: true,
    draining: false,
    activeRuns: 2,
    maxConcurrent: 3,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}
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
};

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
  it('projects fresh ARC and v2 executor contracts without Firestore metadata', async () => {
    const updatedAt = new Date().toISOString();
    mockStore([
      { ...lane, updatedAt, expireAt: Timestamp.now() },
      status({ expireAt: Timestamp.now() }),
    ]);
    const result = await getAutoscalerStatuses();
    expect(result.lanes).toEqual([{ ...lane, updatedAt }]);
    expect(result.queueExecutor).toEqual(
      status({ updatedAt: expect.any(String) }),
    );
    expect(JSON.stringify(result)).not.toContain('expireAt');
  });

  it('ignores retired scale-set records instead of publishing obsolete capacity', async () => {
    mockStore([
      {
        schemaVersion: 1,
        scaleSet: 'retired',
        registration: 'primary',
        queuedJobs: 2,
        minRunners: 0,
        maxRunners: 4,
        draining: false,
        runners: [{ name: 'old', host: 'old', state: 'busy' }],
        updatedAt: new Date().toISOString(),
      },
    ]);
    const result = await getAutoscalerStatuses();
    expect(result).toEqual({ lanes: [], warnings: [] });
    expect(result).not.toHaveProperty('statuses');
  });

  it('rejects malformed ARC counts and unsafe registration URLs, warning for stale producers', async () => {
    const updatedAt = new Date().toISOString();
    mockStore([
      { ...lane, updatedAt: new Date(Date.now() - 181_000).toISOString() },
      { ...lane, updatedAt, runningJobs: NaN },
      { ...lane, updatedAt, registrationUrl: 'javascript:alert(1)' },
      status(),
    ]);
    const result = await getAutoscalerStatuses();
    expect(result.lanes).toEqual([]);
    expect(result.queueExecutor).toBeDefined();
    expect(result.warnings).toContain('ARC lane status is stale.');
    expect(result.warnings).toContain('ARC lane status is invalid.');
    expect(result.lanesIncomplete).toBe(true);
  });

  it('drops stale and malformed executor records without conflating unknown with zero', async () => {
    mockStore([
      status({ updatedAt: new Date(Date.now() - 181_000).toISOString() }),
      status({ ready: 'yes' }),
    ]);
    expect((await getAutoscalerStatuses()).queueExecutor).toBeUndefined();
    mockStore([status({ activeRuns: undefined, maxConcurrent: 0 })]);
    const result = await getAutoscalerStatuses();
    expect(result.queueExecutor).not.toHaveProperty('activeRuns');
    expect(result.queueExecutor?.maxConcurrent).toBe(0);
  });

  it('degrades without throwing when telemetry reads fail', async () => {
    (getAgentTelemetryReaderFirestore as Mock).mockRejectedValue(
      new Error('offline'),
    );
    expect((await getAutoscalerStatuses()).warnings[0]).toContain(
      'unavailable',
    );
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
    emit([status({ activeRuns: 5 })]);

    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ queueExecutor: { activeRuns: 5 } });
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
