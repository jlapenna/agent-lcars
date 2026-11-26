import type { WorkSummary } from '@agent-lcars/work/derive';
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
  loadBridgeStoppedPages,
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
    workHref: '/work?repo=jlapenna%2Fagent-lcars',
    work: {
      authorized: true,
      stoppedCount: 3,
      hasMoreStopped: false,
      eventCount: 4,
      eventWindowed: false,
    },
  };

  it('builds the four linked destination summaries including Work', () => {
    const readouts = bridgeDestinationReadouts(healthyDestinations);
    expect(readouts.map((r) => r.id)).toEqual([
      'agents',
      'shuttlebay',
      'inbox',
      'work',
    ]);
    expect(readouts[3]).toEqual({
      id: 'work',
      label: 'Work',
      href: '/work?repo=jlapenna%2Fagent-lcars',
      value: 3,
      detail: 'Stopped work · 4 event-driven',
    });
  });

  it('marks paged stopped work and windowed event counts as lower bounds', () => {
    const readouts = bridgeDestinationReadouts({
      ...healthyDestinations,
      work: {
        authorized: true,
        stoppedCount: 50,
        hasMoreStopped: true,
        eventCount: 12,
        eventWindowed: true,
      },
    });
    expect(readouts[3]).toMatchObject({
      value: '50+',
      detail: 'Stopped work · 12+ event-driven',
    });
  });

  it('shows unavailable instead of zero when work is unauthorized or failed', () => {
    const unauthorized = bridgeDestinationReadouts({
      ...healthyDestinations,
      work: {
        authorized: false,
        stoppedCount: 0,
        hasMoreStopped: false,
        eventCount: 0,
        eventWindowed: false,
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
        error: 'Could not load stopped work.',
        stoppedCount: 0,
        hasMoreStopped: false,
        eventCount: 0,
        eventWindowed: false,
      },
    });
    expect(errored[3]).toMatchObject({
      value: '—',
      detail: 'Work summary unavailable',
    });
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
    runPipelines?: WorkSummary['spec']['pipeline'][];
  }): WorkSummary => ({
    id: overrides.id,
    anchor: overrides.anchor ?? { workId: overrides.id },
    state: overrides.state ?? 'parked',
    spec: {
      title: overrides.title ?? `Stopped ${overrides.id}`,
      body: 'Body',
      target: { repo: overrides.repo ?? 'jlapenna/agent-lcars' },
      pipeline: overrides.pipeline ?? 'claude',
      deliverable: 'pr',
    },
    origin: {
      kind: 'user',
      principal: overrides.principal ?? 'github:jlapenna',
    },
    runs: (overrides.runPipelines ?? []).map((pipeline, index) => ({
      attemptId: `g1:work:${overrides.id}/r${index + 1}`,
      pipeline,
      state: 'failed',
      startedAt: overrides.updatedAt,
      updatedAt: overrides.updatedAt,
    })),
    createdAt: overrides.updatedAt,
    updatedAt: overrides.updatedAt,
  });

  it('applies the Work destination activity window, agent, and find filters to the stopped count', () => {
    const now = Date.parse('2026-11-26T18:00:00.000Z');
    const items = [
      makeStoppedSummary({
        id: '01RECENT000000000000000001',
        updatedAt: '2026-11-26T17:30:00.000Z', // 30m ago
        pipeline: 'claude',
        title: 'Fresh parked item',
        principal: 'github:jlapenna',
      }),
      makeStoppedSummary({
        id: '01STALE0000000000000000002',
        updatedAt: '2026-11-26T16:00:00.000Z', // 2h ago
        pipeline: 'claude',
        title: 'Two-hour-old parked item',
        principal: 'github:jlapenna',
      }),
      makeStoppedSummary({
        id: '01RUNMATCH0000000000000003',
        updatedAt: '2026-11-26T17:45:00.000Z', // 15m ago
        pipeline: 'claude',
        runPipelines: ['codex'],
        title: 'Retried on codex',
        principal: 'github:operator-2',
      }),
    ];

    const windowed = bridgeDestinationReadouts({
      ...healthyDestinations,
      workHref: '/work?repo=jlapenna%2Fagent-lcars&window=1h',
      work: bridgeWorkSummary({
        authorized: true,
        stoppedItems: items,
        hasMoreStopped: false,
        eventCount: 1,
        eventWindowed: false,
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
        stoppedItems: items,
        hasMoreStopped: false,
        eventCount: 0,
        eventWindowed: false,
        view: { agent: 'codex', window: '1h', q: 'operator-2' },
        now,
      }),
    });
    expect(agentAndFind[3]?.value).toBe(1);
  });

  it('keeps the Work stopped count independent of the panel cursor on the final cursor page', async () => {
    const now = Date.parse('2026-11-26T18:00:00.000Z');
    const firstPageItems = Array.from({ length: 50 }, (_, index) =>
      makeStoppedSummary({
        id: `01PAGE1${String(index).padStart(19, '0')}`,
        updatedAt: '2026-11-26T17:50:00.000Z',
      }),
    );
    const secondPageItems = [
      makeStoppedSummary({
        id: '01PAGE20000000000000000051',
        updatedAt: '2026-11-26T17:40:00.000Z',
      }),
    ];
    const page1Cursor = {
      taskKey: 'work:01PAGE10000000000000000049',
      updatedAt: '2026-11-26T17:50:00.000Z',
    };
    const readPage = vi.fn(async (cursor?: typeof page1Cursor) =>
      cursor
        ? { items: secondPageItems, nextCursor: undefined }
        : { items: firstPageItems, nextCursor: page1Cursor },
    );
    const excludeClosed = vi.fn(async (items: WorkSummary[]) => items);

    // Page 1: single uncursored read shared by panel and destination summary.
    const firstPage = await loadBridgeStoppedPages({
      repo: 'jlapenna/agent-lcars',
      readPage,
      excludeClosed,
    });
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.hasMoreTasks).toBe(true);
    expect(
      bridgeDestinationReadouts({
        ...healthyDestinations,
        work: bridgeWorkSummary({
          authorized: true,
          stoppedItems: firstPage.summaryStoppedItems,
          hasMoreStopped: firstPage.summaryHasMoreStopped,
          eventCount: 2,
          eventWindowed: false,
          view: {},
          now,
        }),
      })[3]?.value,
    ).toBe('50+');

    // Final cursor page (item #51): panel shows 1 item with no next cursor,
    // while the Work destination readout stays qualified at 50+.
    readPage.mockClear();
    const finalPage = await loadBridgeStoppedPages({
      cursor: page1Cursor,
      repo: 'jlapenna/agent-lcars',
      readPage,
      excludeClosed,
    });
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(finalPage.items).toHaveLength(1);
    expect(finalPage.hasMoreTasks).toBe(false);
    expect(
      bridgeDestinationReadouts({
        ...healthyDestinations,
        work: bridgeWorkSummary({
          authorized: true,
          stoppedItems: finalPage.summaryStoppedItems,
          hasMoreStopped: finalPage.summaryHasMoreStopped,
          eventCount: 2,
          eventWindowed: false,
          view: {},
          now,
        }),
      })[3]?.value,
    ).toBe('50+');
  });

  it('counts only native Work items in the Work card while retaining GitHub-anchored items for the panel', async () => {
    const now = Date.parse('2026-11-26T18:00:00.000Z');
    const githubParked = makeStoppedSummary({
      id: 'jlapenna/agent-lcars#3662',
      anchor: { repo: 'jlapenna/agent-lcars', issue: 3662 },
      updatedAt: '2026-11-26T17:55:00.000Z',
    });
    const nativeParked = makeStoppedSummary({
      id: '01NATIVE000000000000000001',
      updatedAt: '2026-11-26T17:50:00.000Z',
    });

    // With one open parked GitHub issue and zero native matches, the Work card
    // reports 0 (matching `/work`), not 1.
    const githubOnly = bridgeDestinationReadouts({
      ...healthyDestinations,
      work: bridgeWorkSummary({
        authorized: true,
        stoppedItems: [githubParked],
        hasMoreStopped: false,
        eventCount: 0,
        eventWindowed: false,
        view: {},
        now,
      }),
    });
    expect(githubOnly[3]?.value).toBe(0);

    // Page 1: panel keeps both anchors, Work summary keeps only native items.
    const readPage = vi.fn(async () => ({
      items: [githubParked, nativeParked],
      nextCursor: undefined,
    }));
    const excludeClosed = vi.fn(async (items: WorkSummary[]) => items);
    const page1 = await loadBridgeStoppedPages({
      repo: 'jlapenna/agent-lcars',
      readPage,
      excludeClosed,
    });
    expect(page1.items.map((item) => item.id)).toEqual([
      githubParked.id,
      nativeParked.id,
    ]);
    expect(page1.summaryStoppedItems.map((item) => item.id)).toEqual([
      nativeParked.id,
    ]);
    expect(
      bridgeDestinationReadouts({
        ...healthyDestinations,
        work: bridgeWorkSummary({
          authorized: true,
          stoppedItems: page1.summaryStoppedItems,
          hasMoreStopped: page1.summaryHasMoreStopped,
          eventCount: 0,
          eventWindowed: false,
          view: {},
          now,
        }),
      })[3]?.value,
    ).toBe(1);
  });

  it('keeps the selected cursor page healthy when the uncursored Work summary read fails and skips page-one GitHub lookups', async () => {
    const page1Cursor = {
      taskKey: 'work:01PAGE10000000000000000049',
      updatedAt: '2026-11-26T17:50:00.000Z',
    };
    const page2Cursor = {
      taskKey: 'work:01PAGE20000000000000000099',
      updatedAt: '2026-11-26T17:40:00.000Z',
    };
    const page1Github = makeStoppedSummary({
      id: 'jlapenna/agent-lcars#9001',
      anchor: { repo: 'jlapenna/agent-lcars', issue: 9001 },
      updatedAt: '2026-11-26T17:55:00.000Z',
    });
    const page1Native = makeStoppedSummary({
      id: '01PAGE1NATIVE0000000000001',
      updatedAt: '2026-11-26T17:52:00.000Z',
    });
    const page2Item = makeStoppedSummary({
      id: '01PAGE20000000000000000051',
      updatedAt: '2026-11-26T17:40:00.000Z',
    });

    // Case 1: uncursored summary query fails while the selected cursor page
    // succeeds with items and a nextCursor — panel data stays intact and only
    // the Work card receives `summaryError`.
    const summaryFailure = new Error('Firestore deadline exceeded');
    const onSummaryError = vi.fn();
    const failedSummary = await loadBridgeStoppedPages({
      cursor: page1Cursor,
      repo: 'jlapenna/agent-lcars',
      readPage: vi.fn(async (cursor?: typeof page1Cursor) => {
        if (!cursor) throw summaryFailure;
        return { items: [page2Item], nextCursor: page2Cursor };
      }),
      excludeClosed: vi.fn(async (items: WorkSummary[]) => items),
      onSummaryError,
    });
    expect(onSummaryError).toHaveBeenCalledWith(summaryFailure);
    expect(failedSummary.items).toEqual([page2Item]);
    expect(failedSummary.hasMoreTasks).toBe(true);
    expect(failedSummary.nextCursor).toEqual(page2Cursor);
    expect(failedSummary.summaryStoppedItems).toEqual([]);
    expect(failedSummary.summaryHasMoreStopped).toBe(false);
    expect(failedSummary.summaryError).toBe('Work summary unavailable');
    expect(
      bridgeDestinationReadouts({
        ...healthyDestinations,
        work: bridgeWorkSummary({
          authorized: true,
          error: failedSummary.summaryError,
          stoppedItems: failedSummary.summaryStoppedItems,
          hasMoreStopped: failedSummary.summaryHasMoreStopped,
          eventCount: 2,
          eventWindowed: false,
          view: {},
        }),
      })[3],
    ).toMatchObject({
      value: '—',
      detail: 'Work summary unavailable',
    });

    // Case 2: on a cursor page, page-one GitHub anchors never pass through
    // `excludeClosed` (so a projection failure for a page-one GitHub issue
    // cannot break the cursor page or the native Work summary).
    const excludeClosed = vi.fn(async (items: WorkSummary[]) => {
      if (items.some((item) => item.id === page1Github.id)) {
        throw new Error('GitHub projection read failed');
      }
      return items;
    });
    const healthyCursor = await loadBridgeStoppedPages({
      cursor: page1Cursor,
      repo: 'jlapenna/agent-lcars',
      readPage: vi.fn(async (cursor?: typeof page1Cursor) =>
        cursor
          ? { items: [page2Item], nextCursor: page2Cursor }
          : { items: [page1Github, page1Native], nextCursor: page1Cursor },
      ),
      excludeClosed,
    });
    expect(excludeClosed).toHaveBeenCalledTimes(1);
    expect(healthyCursor.items).toEqual([page2Item]);
    expect(healthyCursor.nextCursor).toEqual(page2Cursor);
    expect(healthyCursor.summaryError).toBeUndefined();
    expect(healthyCursor.summaryStoppedItems).toEqual([page1Native]);
    expect(healthyCursor.summaryHasMoreStopped).toBe(true);
  });
});
