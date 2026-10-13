import { getAgentTelemetryReaderFirestore } from '@agent-lcars/telemetry/server';
import { Timestamp } from 'firebase-admin/firestore';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { fleetFromAutoscalerStatuses } from './agent-activity';
import {
  getAutoscalerStatuses,
  projectAutoscalerStatuses,
  subscribeAutoscalerStatuses,
} from './autoscaler-status';
import {
  ARC_UNBOUNDED_MAX_RUNNERS,
  fleetCapacity,
} from './runner-status-contract';

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
  expectedLanes: 'lcars-ci',
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

  it('reads an unbounded scale set as having no maximum, never as int32 runners', async () => {
    const updatedAt = new Date().toISOString();
    mockStore([
      { ...lane, updatedAt, maxRunners: ARC_UNBOUNDED_MAX_RUNNERS },
      { ...lane, lane: 'lcars-e2e', updatedAt },
    ]);
    const result = await getAutoscalerStatuses();
    expect(result.lanes?.[0]).not.toHaveProperty('maxRunners');
    expect(fleetCapacity(result.lanes ?? [])).toBeUndefined();
    expect(fleetFromAutoscalerStatuses(result)).not.toHaveProperty('capacity');
    expect(fleetCapacity([{ maxRunners: 4 }, { maxRunners: 2 }])).toBe(6);
  });

  it('streams a compact job-startup window and drops only a malformed one', async () => {
    const updatedAt = new Date().toISOString();
    mockStore([
      {
        ...lane,
        updatedAt,
        jobStartup: {
          bounds: [1, 10],
          intervals: [{ endedAt: updatedAt, counts: [0, 2, 3] }],
        },
      },
      {
        ...lane,
        lane: 'lcars-e2e',
        updatedAt,
        jobStartup: { bounds: [1, 10], intervals: [{ endedAt: updatedAt }] },
      },
    ]);
    const result = await getAutoscalerStatuses();
    expect(result.lanes?.map((arc) => arc.lane)).toEqual([
      'lcars-ci',
      'lcars-e2e',
    ]);
    expect(result.lanes?.map((arc) => arc.jobStartup)).toEqual([
      {
        bounds: [1, 10],
        endedAt: updatedAt,
        minutes: [
          {
            endedAt: updatedAt,
            jobs: [
              [1, 2],
              [2, 1],
            ],
          },
        ],
      },
      undefined,
    ]);
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

describe('authoritative ARC inventory', () => {
  const now = Date.parse('2026-10-09T20:00:00Z');
  const fresh = {
    ...lane,
    updatedAt: new Date(now).toISOString(),
    expectedLanes: 'lcars-ci,lcars-e2e',
  };

  // The production incident retained four retired snapshots after the fleet
  // changed from fifteen configured lanes to these twelve surviving producers.
  const configured = [
    'build-client',
    'control',
    'default',
    'e2e',
    'girosf-default',
    'homelab-ci',
    'homelab-control',
    'lcars-ci',
    'lcars-e2e',
    'nx-cache-server-default',
    'sync-padd-default',
    'www-default',
  ];
  const current = configured.map((name) => ({
    ...fresh,
    lane: name,
    expectedLanes: configured.join(','),
  }));
  const retired = ['ci-light', 'e2e-light', 'lcars-default', 'wait'].map(
    (name) => ({
      ...fresh,
      lane: name,
      expectedLanes: [...configured, 'ci-light', 'e2e-light', 'lcars-default']
        .sort()
        .join(','),
      updatedAt: new Date(now - 86_400_000).toISOString(),
      registeredRunners: 100,
      runningJobs: 100,
    }),
  );

  it('publishes current twelve-lane totals without waiting for retired snapshot TTL deletion', () => {
    const result = projectAutoscalerStatuses([...current, ...retired], now);
    expect(result.lanes).toEqual(current);
    expect(result.lanesIncomplete).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(fleetFromAutoscalerStatuses(result)).toMatchObject({
      online: 24,
      busy: 12,
    });
    const zero = projectAutoscalerStatuses(
      [
        ...current.map((record) => ({
          ...record,
          registeredRunners: 0,
          runningJobs: 0,
        })),
        ...retired,
      ],
      now,
    );
    expect(fleetFromAutoscalerStatuses(zero)).toMatchObject({
      online: 0,
      busy: 0,
    });
  });

  it('ignores malformed counters only when fresh inventory proves the expired lane was retired', () => {
    const result = projectAutoscalerStatuses(
      [
        ...current,
        ...retired.map((record) => ({ ...record, runningJobs: NaN })),
      ],
      now,
    );
    expect(result.lanesIncomplete).toBeUndefined();
    expect(fleetFromAutoscalerStatuses(result)).toMatchObject({
      online: 24,
      busy: 12,
    });
  });

  it.each([
    'missing',
    'expired',
    'malformed',
    'disagrees',
    'all-expired',
    'fresh-unexpected',
    'unknown-retired-age',
  ] as const)(
    'retains unknown totals for %s evidence and restores them after configured producers recover',
    (failure) => {
      const first = current[0];
      const bad = {
        missing: current.slice(1),
        expired: [
          { ...first, updatedAt: new Date(now - 180_001).toISOString() },
          ...current.slice(1),
        ],
        malformed: [{ ...first, runningJobs: NaN }, ...current.slice(1)],
        disagrees: [
          { ...first, expectedLanes: `${first.expectedLanes},new-lane` },
          ...current.slice(1),
        ],
        'all-expired': current.map((record) => ({
          ...record,
          updatedAt: new Date(now - 180_001).toISOString(),
        })),
        'fresh-unexpected': [
          ...current,
          {
            ...retired[0],
            expectedLanes: first.expectedLanes,
            updatedAt: new Date(now).toISOString(),
          },
        ],
        'unknown-retired-age': [
          ...current,
          { ...retired[0], updatedAt: 'unknown' },
        ],
      }[failure];
      const result = projectAutoscalerStatuses([...bad, ...retired], now);
      expect(result.lanesIncomplete).toBe(true);
      expect(fleetFromAutoscalerStatuses(result)).not.toHaveProperty('online');
      expect(fleetFromAutoscalerStatuses(result)).not.toHaveProperty('busy');
      expect(
        fleetFromAutoscalerStatuses(
          projectAutoscalerStatuses([...current, ...retired], now),
        ),
      ).toMatchObject({ online: 24, busy: 12 });
    },
  );

  it('suppresses totals when a configured lane never published or disappeared after TTL', () => {
    const result = projectAutoscalerStatuses([fresh], now);
    expect(result.lanes).toEqual([fresh]);
    expect(result.lanesIncomplete).toBe(true);
    expect(result.warnings).toContain('Configured ARC lane status is missing.');
    expect(fleetFromAutoscalerStatuses(result)).not.toHaveProperty('online');
    expect(fleetFromAutoscalerStatuses(result)).not.toHaveProperty('busy');
  });

  it('requires every configured lane before publishing complete or zero totals', () => {
    const second = {
      ...fresh,
      lane: 'lcars-e2e',
      registeredRunners: 0,
      runningJobs: 0,
    };
    const complete = projectAutoscalerStatuses([fresh, second], now);
    expect(complete.lanesIncomplete).toBeUndefined();
    expect(fleetFromAutoscalerStatuses(complete)).toMatchObject({
      online: 2,
      busy: 1,
    });
    const zero = projectAutoscalerStatuses(
      [{ ...fresh, registeredRunners: 0, runningJobs: 0 }, second],
      now,
    );
    expect(fleetFromAutoscalerStatuses(zero)).toMatchObject({
      online: 0,
      busy: 0,
    });
  });

  it.each([
    undefined,
    '',
    'lcars-ci,lcars-ci',
    'lcars-ci,INVALID',
    Array.from({ length: 65 }, (_, i) => `lane-${i}`).join(','),
  ])('fails closed on missing or malformed inventory %s', (expectedLanes) => {
    const result = projectAutoscalerStatuses(
      [{ ...fresh, expectedLanes }],
      now,
    );
    expect(result.lanesIncomplete).toBe(true);
    expect(fleetFromAutoscalerStatuses(result)).not.toHaveProperty('online');
  });

  it('rejects conflicting inventories and duplicate or unexpected producer records', () => {
    const second = { ...fresh, lane: 'lcars-e2e' };
    for (const records of [
      [fresh, { ...second, expectedLanes: 'lcars-e2e' }],
      [fresh, fresh],
      [fresh, second, { ...fresh, lane: 'unconfigured' }],
    ]) {
      const result = projectAutoscalerStatuses(records, now);
      expect(result.lanesIncomplete).toBe(true);
      expect(fleetFromAutoscalerStatuses(result)).not.toHaveProperty('busy');
    }
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

  it.each([0, 1, Number.MAX_SAFE_INTEGER])(
    'preserves signed Firestore claim integers through the reader: %s',
    (count) => {
      const updatedAt = new Date(now).toISOString();
      const claims = {
        claude: count,
        codex: count,
        opencode: count,
        windowStart: new Date(now - 10_000).toISOString(),
        windowEnd: updatedAt,
      };
      // Firestore integer_value fields decode to these exact JS numbers.
      // The Go SDK Commit regression verifies the producer's wire types.
      const result = projectAutoscalerStatuses(
        [
          status({
            updatedAt,
            expireAt: Timestamp.fromMillis(now + 180_000),
            claims,
          }),
        ],
        now,
      );
      expect(result.queueExecutor?.claims).toEqual(claims);
      expect(JSON.parse(JSON.stringify(result.queueExecutor))?.claims).toEqual(
        claims,
      );
    },
  );
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
