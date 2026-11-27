import type { ItemView, WorkSummary } from '@agent-lcars/work/derive';
import { describe, expect, it, vi } from 'vitest';

import type { RunTimeline } from '../lib/run-history';
import {
  bridgeDestinationReadouts,
  type BridgeDestinationReadoutsInput,
  type BridgeReadoutInput,
  bridgeReadouts,
  bridgeWorkSummary,
  dayOfHours,
  fleetReadoutInput,
  loadBridgeAdmittedWork,
  loadBridgeStoppedPage,
  STOPPED_WORK_PANEL_ERROR,
  WORK_SUMMARY_UNAVAILABLE_ERROR,
} from './bridge-readouts';

const healthy: BridgeReadoutInput = {
  fleet: { online: 11, busy: 7, capacity: 12 },
  liveRuns: [
    { pipeline: 'claude', status: 'running', elapsedSeconds: 600 },
    { pipeline: 'claude', status: 'running', elapsedSeconds: 60 },
    { pipeline: 'codex', status: 'running', elapsedSeconds: 60 },
    { pipeline: 'codex', status: 'queued', elapsedSeconds: 1_080 },
  ],
  liveRunsAvailable: true,
  cliSessions: [],
  queue: { queued: 1, claimed: 2, running: 3 },
  spendToday: { costUsd: 38.42, estimated: false, partial: false },
};

const byId = (input: BridgeReadoutInput) =>
  Object.fromEntries(bridgeReadouts(input).map((r) => [r.id, r]));

describe('bridgeReadouts', () => {
  it('divides busy runners by the lanes, not by pods from the inventory', () => {
    // Pods online (3) can disagree with the lanes' registered runners (5),
    // e.g. pods on a NotReady host; running jobs are a lane measure.
    const r = byId({
      ...healthy,
      fleet: { online: 3, registered: 5, busy: 4, capacity: 3 },
    });
    expect(r['online']?.value).toBe('3 / 3');
    expect(r['busy']).toMatchObject({
      value: '4 / 5',
      detail: '80% utilisation · 1 idle',
    });
  });

  it('reports the mockup readouts from healthy reads', () => {
    const r = byId(healthy);
    expect(r['online']?.value).toBe('11 / 12');
    expect(r['busy']).toMatchObject({
      value: '7 / 11',
      detail: '64% utilisation · 4 idle',
    });
    expect(r['queue']).toMatchObject({ value: 3 });
    expect(r['queue']?.detail).toContain('2 claimed · oldest');
    expect(r['running']).toMatchObject({
      value: 3,
      detail: 'claude 2 · codex 1',
    });
    // The cost budget is window-scoped, so today is never shown as a share.
    expect(r['spend']?.detail).toBe('since 00:00 UTC · no daily budget');
  });

  it('includes local processes without counting ended, stale or duplicate sessions', () => {
    const sessions = [
      ...Array.from({ length: 9 }, (_, index) => ({
        sessionId: `local-${index}`,
        agent: 'codex' as const,
        liveness: index === 0 ? ('idle' as const) : ('live' as const),
      })),
      {
        sessionId: 'ended',
        agent: 'codex' as const,
        liveness: 'ended' as const,
      },
      {
        sessionId: 'stale',
        agent: 'codex' as const,
        liveness: 'stale' as const,
      },
    ];
    const r = byId({ ...healthy, cliSessions: [...sessions, sessions[0]!] });
    expect(r['running']).toMatchObject({
      value: 12,
      detail: 'claude 2 · codex 10',
    });
    expect(r['queue']?.value).toBe(3);
    expect(
      byId({ ...healthy, cliSessions: undefined })['running'],
    ).toMatchObject({
      value: '—',
      detail: 'unavailable',
    });
    expect(
      byId({ ...healthy, liveRunsAvailable: false })['running']?.value,
    ).toBe('—');
  });

  it('marks spend with incomplete archive coverage as a lower bound', () => {
    const r = byId({
      ...healthy,
      spendToday: { costUsd: 38.42, estimated: false, partial: true },
    });
    expect(r['spend']).toMatchObject({
      value: '$38.42+',
      detail: 'partial: session archive coverage incomplete',
    });
  });

  it('never turns failed reads into zeros', () => {
    const r = byId({
      fleet: {},
      liveRuns: [],
      liveRunsAvailable: false,
    });
    for (const id of ['online', 'busy', 'queue', 'running', 'spend']) {
      expect(r[id]?.value).toBe('—');
    }
  });

  it('draws queue and running sparklines from the history, others unavailable', () => {
    const r = byId({
      ...healthy,
      history: { queued: [0, 2, 3], running: [1, 3, 3] },
    });
    expect(r['queue']?.spark).toEqual({
      label: 'Queue depth, last 30 minutes',
      values: [0, 2, 3],
    });
    expect(r['running']?.spark?.values).toEqual([1, 3, 3]);
    for (const id of ['online', 'busy', 'spend']) {
      expect(r[id]?.spark?.values).toBeUndefined();
    }
    expect(byId(healthy)['queue']?.spark?.values).toBeUndefined();
  });

  it('draws runner and hourly spend sparklines when their sources report', () => {
    const r = byId({
      ...healthy,
      runnerHistory: { online: [12, undefined, 11], busy: [6, undefined, 7] },
      spendToday: {
        costUsd: 3,
        byHourUsd: [1, 0, 2],
        estimated: false,
        partial: true,
      },
    });
    expect(r['online']?.spark?.values).toEqual([12, undefined, 11]);
    expect(r['busy']?.spark?.values).toEqual([6, undefined, 7]);
    expect(r['spend']?.spark).toEqual({
      label: 'Spend per hour today, by last activity (lower bound)',
      // 24 slots ending at the current hour; those before midnight empty.
      values: [...Array.from({ length: 21 }, () => undefined), 1, 0, 2],
    });
  });
});

describe('fleetReadoutInput', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const timeline = (owner: string): RunTimeline => ({
    repo: { owner, name: 'repo' },
    createdAt: new Date(now - 5 * 60_000).toISOString(),
    transitions: [],
    state: 'pending',
    updatedAt: new Date(now - 5 * 60_000).toISOString(),
  });

  it('narrows the run history to the page scope', () => {
    const input = fleetReadoutInput({
      activity: {
        queue: { queued: 2, claimed: 0, running: 0 },
        runHistory: [timeline('a'), timeline('b')],
      },
      liveRuns: [],
      repo: 'a/repo',
      autoscaler: {},
      now,
    });
    expect(input.history?.queued.at(-1)).toBe(1);
    expect(input.history?.queued[0]).toBe(0);
  });

  it('takes fleet runner history from the lanes, and none while one is missing', () => {
    const lane = (
      runnerHistory?: { at: string; registered: number; running: number }[],
    ) =>
      ({
        schemaVersion: 3,
        kind: 'arc-lane',
        lane: 'l',
        registrationUrl: 'https://github.com/o',
        assignedJobs: 0,
        runningJobs: 0,
        pendingJobs: 0,
        idleRunners: 0,
        registeredRunners: 0,
        desiredRunners: 0,
        minRunners: 0,
        updatedAt: new Date(now).toISOString(),
        ...(runnerHistory ? { runnerHistory } : {}),
      }) as const;
    const sample = [
      { at: new Date(now - 5_000).toISOString(), registered: 3, running: 2 },
    ];
    const withHistory = fleetReadoutInput({
      // Pods online (8) differ from the lanes' registered runners (7).
      activity: { fleet: { online: 8, registered: 7, busy: 5 } },
      liveRuns: [],
      autoscaler: { lanes: [lane(sample), lane(sample)] },
      now,
    });
    // The lanes sampled 6/4 a minute ago; the newest bar is their current
    // count, never the pod count from a different measure.
    expect(withHistory.runnerHistory?.online.slice(-2)).toEqual([undefined, 7]);
    expect(withHistory.runnerHistory?.busy.at(-1)).toBe(5);
    expect(
      fleetReadoutInput({
        activity: {},
        liveRuns: [],
        autoscaler: { lanes: [lane(sample), lane()] },
        now,
      }).runnerHistory,
    ).toBeUndefined();
    expect(
      fleetReadoutInput({
        activity: {},
        liveRuns: [],
        autoscaler: { lanes: [lane(sample)], lanesIncomplete: true },
        now,
      }).runnerHistory,
    ).toBeUndefined();
  });

  it('has no history when the live read failed', () => {
    const input = fleetReadoutInput({
      activity: { runHistory: [timeline('a')] },
      liveRuns: [],
      autoscaler: {},
      now,
    });
    expect(input.history).toBeUndefined();
  });
});

describe('dayOfHours', () => {
  it('keeps a day of hourly slots so early hours draw as bars, not a block', () => {
    const values = dayOfHours([1.5]);
    expect(values).toHaveLength(24);
    expect(values?.slice(0, 23).every((v) => v === undefined)).toBe(true);
    expect(values?.at(-1)).toBe(1.5);
    expect(dayOfHours(undefined)).toBeUndefined();
    expect(dayOfHours(Array.from({ length: 24 }, () => 1))).toHaveLength(24);
  });
});

describe('bridgeDestinationReadouts', () => {
  const healthyDestinations: BridgeDestinationReadoutsInput = {
    agentsHref: '/agents?repo=jlapenna%2Fagent-lcars',
    liveRunCount: 5,
    liveRunsAvailable: true,
    activeCliSessionCount: 12,
    cliSessionsAvailable: true,
    runnerCount: '16 / 21',
    hasHostInventory: true,
    inboxHref: '/inbox?repo=jlapenna%2Fagent-lcars',
    decisionCount: 2,
    nativeInboxAvailable: true,
    jobs: { count: 8, detail: '6 enabled · all permitted repos' },
    costsHref: '/costs?repo=jlapenna%2Fagent-lcars',
    spend: { todayUsd: 24.6, todayEstimated: false },
    workHref: '/work?repo=jlapenna%2Fagent-lcars',
    work: {
      authorized: true,
      admittedCount: 1,
      hasMoreAdmitted: false,
    },
  };

  it('builds the six linked destination summaries including Work admitted queue', () => {
    const readouts = bridgeDestinationReadouts(healthyDestinations);
    expect(readouts.map((r) => r.id)).toEqual([
      'agents',
      'shuttlebay',
      'inbox',
      'work',
      'jobs',
      'costs',
    ]);
    expect(readouts[3]).toEqual({
      id: 'work',
      label: 'Work',
      href: '/work?repo=jlapenna%2Fagent-lcars',
      value: 1,
      detail: 'Admitted queue · native work',
    });
  });

  it('marks a full page of admitted work as a lower bound', () => {
    const readouts = bridgeDestinationReadouts({
      ...healthyDestinations,
      work: {
        authorized: true,
        admittedCount: 200,
        hasMoreAdmitted: true,
      },
    });
    expect(readouts[3]).toMatchObject({
      value: '200+',
      detail: 'Admitted queue · native work',
    });
  });

  it('shows unavailable instead of zero when work is unauthorized or failed', () => {
    const unauthorized = bridgeDestinationReadouts({
      ...healthyDestinations,
      work: {
        authorized: false,
        admittedCount: 0,
        hasMoreAdmitted: false,
      },
    });
    expect(unauthorized[3]).toMatchObject({
      value: '—',
      detail: 'Work grant required',
    });

    const errored = bridgeDestinationReadouts({
      ...healthyDestinations,
      work: {
        authorized: true,
        error: WORK_SUMMARY_UNAVAILABLE_ERROR,
        admittedCount: 0,
        hasMoreAdmitted: false,
      },
    });
    expect(errored[3]).toMatchObject({
      value: '—',
      detail: 'Work summary unavailable',
    });
  });

  const makeAdmittedItem = (overrides: {
    id: string;
    updatedAt: string;
    repo?: string;
    pipeline?: ItemView['spec']['pipeline'];
    title?: string;
    principal?: string;
    state?: ItemView['state'];
    runPipelines?: ItemView['spec']['pipeline'][];
  }): ItemView => ({
    id: overrides.id,
    state: overrides.state ?? 'running',
    spec: {
      title: overrides.title ?? `Admitted ${overrides.id}`,
      description: 'Description',
      target: { repo: overrides.repo ?? 'jlapenna/agent-lcars' },
      pipeline: overrides.pipeline ?? 'claude',
    },
    origin: {
      channel: 'console',
      principal: overrides.principal ?? 'github:jlapenna',
    },
    runs: (overrides.runPipelines ?? []).map((pipeline, index) => ({
      runId: `work:${overrides.id}/r${index + 1}`,
      pipeline,
      state: 'running',
      createdAt: overrides.updatedAt,
      updatedAt: overrides.updatedAt,
    })),
    sessions: [],
    createdAt: overrides.updatedAt,
    updatedAt: overrides.updatedAt,
  });

  const makeStoppedSummary = (overrides: {
    id: string;
    anchor?: WorkSummary['anchor'];
    updatedAt: string;
    repo?: string;
    pipeline?: WorkSummary['spec']['pipeline'];
    title?: string;
    principal?: string;
    state?: WorkSummary['state'];
  }): WorkSummary => ({
    id: overrides.id,
    anchor: overrides.anchor ?? { workId: overrides.id },
    state: overrides.state ?? 'parked',
    spec: {
      title: overrides.title ?? `Stopped ${overrides.id}`,
      description: 'Description',
      target: { repo: overrides.repo ?? 'jlapenna/agent-lcars' },
      pipeline: overrides.pipeline ?? 'claude',
    },
    origin: {
      channel: 'console',
      principal: overrides.principal ?? 'github:jlapenna',
    },
    runs: [],
    createdAt: overrides.updatedAt,
    updatedAt: overrides.updatedAt,
  });

  it('applies the Work destination activity window, agent, and find filters and ignores non-running items', () => {
    const now = Date.parse('2026-11-26T18:00:00.000Z');
    const items = [
      makeAdmittedItem({
        id: '01RECENT000000000000000001',
        updatedAt: '2026-11-26T17:30:00.000Z', // 30m ago
        pipeline: 'claude',
        title: 'Fresh running item',
        principal: 'github:jlapenna',
      }),
      makeAdmittedItem({
        id: '01STALE0000000000000000002',
        updatedAt: '2026-11-26T16:00:00.000Z', // 2h ago
        pipeline: 'claude',
        title: 'Two-hour-old running item',
        principal: 'github:jlapenna',
      }),
      makeAdmittedItem({
        id: '01RUNMATCH0000000000000003',
        updatedAt: '2026-11-26T17:45:00.000Z', // 15m ago
        pipeline: 'claude',
        runPipelines: ['codex'],
        title: 'Retried on codex',
        principal: 'github:operator-2',
      }),
      makeAdmittedItem({
        id: '01PARKED000000000000000004',
        updatedAt: '2026-11-26T17:50:00.000Z',
        state: 'parked',
        title: 'Parked item excluded from admitted queue',
      }),
    ];

    const windowed = bridgeDestinationReadouts({
      ...healthyDestinations,
      workHref: '/work?repo=jlapenna%2Fagent-lcars&window=1h',
      work: bridgeWorkSummary({
        authorized: true,
        admittedItems: items,
        hasMoreAdmitted: false,
        view: { window: '1h' },
        now,
      }),
    });
    expect(windowed[3]?.value).toBe(2);

    const agentAndFind = bridgeDestinationReadouts({
      ...healthyDestinations,
      workHref:
        '/work?repo=jlapenna%2Fagent-lcars&agent=codex&window=1h&q=operator-2',
      work: bridgeWorkSummary({
        authorized: true,
        admittedItems: items,
        hasMoreAdmitted: false,
        view: { agent: 'codex', window: '1h', q: 'operator-2' },
        now,
      }),
    });
    expect(agentAndFind[3]?.value).toBe(1);
  });

  it('loads admitted native work scoped by repository and reports errors without throwing', async () => {
    const lcarsItem = makeAdmittedItem({
      id: '01LCARS0000000000000000001',
      updatedAt: '2026-11-26T17:55:00.000Z',
      repo: 'jlapenna/agent-lcars',
    });
    const homelabItem = makeAdmittedItem({
      id: '01HOMELAB00000000000000002',
      updatedAt: '2026-11-26T17:50:00.000Z',
      repo: 'jlapenna/homelab',
    });
    const parkedItem = makeAdmittedItem({
      id: '01PARKED000000000000000003',
      updatedAt: '2026-11-26T17:45:00.000Z',
      repo: 'jlapenna/agent-lcars',
      state: 'parked',
    });

    const scoped = await loadBridgeAdmittedWork({
      repo: 'jlapenna/agent-lcars',
      readAdmitted: vi.fn(async () => ({
        items: [lcarsItem, homelabItem, parkedItem],
        hasMore: false,
      })),
    });
    expect(scoped.error).toBeUndefined();
    expect(scoped.hasMoreAdmitted).toBe(false);
    expect(scoped.admittedItems.map((item) => item.id)).toEqual([lcarsItem.id]);

    const failure = new Error('Firestore deadline exceeded');
    const onError = vi.fn();
    const failed = await loadBridgeAdmittedWork({
      repo: 'jlapenna/agent-lcars',
      readAdmitted: vi.fn(async () => {
        throw failure;
      }),
      onError,
    });
    expect(onError).toHaveBeenCalledWith(failure);
    expect(failed.admittedItems).toEqual([]);
    expect(failed.hasMoreAdmitted).toBe(false);
    expect(failed.error).toBe(WORK_SUMMARY_UNAVAILABLE_ERROR);
    expect(
      bridgeDestinationReadouts({
        ...healthyDestinations,
        work: bridgeWorkSummary({
          authorized: true,
          error: failed.error,
          admittedItems: failed.admittedItems,
          hasMoreAdmitted: failed.hasMoreAdmitted,
          view: {},
        }),
      })[3],
    ).toMatchObject({
      value: '—',
      detail: 'Work summary unavailable',
    });
  });

  it('keeps the Stopped work panel isolated from admitted work across cursors and failures', async () => {
    const githubParked = makeStoppedSummary({
      id: 'jlapenna/agent-lcars#3662',
      anchor: { repo: 'jlapenna/agent-lcars', issue: 3662 },
      updatedAt: '2026-11-26T17:55:00.000Z',
    });
    const nativeParked = makeStoppedSummary({
      id: '01NATIVE000000000000000001',
      updatedAt: '2026-11-26T17:50:00.000Z',
    });
    const page1Cursor = {
      taskKey: 'work:01NATIVE000000000000000001',
      updatedAt: '2026-11-26T17:50:00.000Z',
    };

    // Valid cursor page keeps both GitHub and native stopped items for the panel.
    const readPage = vi.fn(async () => ({
      items: [githubParked, nativeParked],
      nextCursor: page1Cursor,
    }));
    const excludeClosed = vi.fn(async (items: WorkSummary[]) => items);
    const loaded = await loadBridgeStoppedPage({
      rawCursor: JSON.stringify(page1Cursor),
      repo: 'jlapenna/agent-lcars',
      readPage,
      excludeClosed,
    });
    expect(readPage).toHaveBeenCalledWith(page1Cursor);
    expect(loaded.panelError).toBeUndefined();
    expect(loaded.items.map((item) => item.id)).toEqual([
      githubParked.id,
      nativeParked.id,
    ]);
    expect(loaded.hasMoreTasks).toBe(true);
    expect(loaded.nextCursor).toEqual(page1Cursor);

    // Invalid cursor fails only the Stopped work panel without reading the store.
    const invalidRead = vi.fn();
    const onPanelError = vi.fn();
    const invalid = await loadBridgeStoppedPage({
      rawCursor: '{not-valid-json',
      repo: 'jlapenna/agent-lcars',
      readPage: invalidRead,
      excludeClosed,
      onPanelError,
    });
    expect(invalidRead).not.toHaveBeenCalled();
    expect(onPanelError).toHaveBeenCalledTimes(1);
    expect(invalid.panelError).toBe(STOPPED_WORK_PANEL_ERROR);
    expect(invalid.items).toEqual([]);
    expect(invalid.hasMoreTasks).toBe(false);

    // GitHub projection failure fails only the Stopped work panel.
    const projectionError = new Error('GitHub projection read failed');
    const onProjectionError = vi.fn();
    const projectionFailed = await loadBridgeStoppedPage({
      repo: 'jlapenna/agent-lcars',
      readPage,
      excludeClosed: vi.fn(async () => {
        throw projectionError;
      }),
      onPanelError: onProjectionError,
    });
    expect(onProjectionError).toHaveBeenCalledWith(projectionError);
    expect(projectionFailed.panelError).toBe(STOPPED_WORK_PANEL_ERROR);
    expect(projectionFailed.items).toEqual([]);
  });
});
