import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  queue: vi.fn(),
  activity: vi.fn(),
  sessions: vi.fn(),
  native: vi.fn(),
  context: vi.fn(),
  snoozes: vi.fn(),
}));
vi.mock('./decision-snooze-store', () => ({
  getDecisionSnoozeStore: () => ({ read: mocks.snoozes }),
}));
vi.mock('../auth', () => ({ auth: mocks.auth }));
vi.mock('./dashboard-data', () => ({
  getCachedQueueItems: mocks.queue,
  getCachedAgentActivity: mocks.activity,
}));
vi.mock('./runner-sessions', () => ({
  getRunnerSessionsByRunId: mocks.sessions,
}));
vi.mock('./native-inbox', () => ({ getNativeInboxCards: mocks.native }));
vi.mock('../app/work/context', () => ({ context: mocks.context }));
import type { InboxCard } from '../app/inbox-card';
import { inboxCardSignature } from '../app/inbox-card';
import {
  advanceNotificationState,
  emptyNotificationState,
  NOTIFICATION_FRESH_MS,
} from './inbox-notifications';
import {
  loadInboxNotificationSnapshot,
  notificationDecisions,
} from './inbox-notifications-data';

const github = {
  item: {
    repo: { owner: 'owner', name: 'repo' },
    number: 1,
    actionTypes: ['needs-human'],
    title: 'SECRET',
    body: 'SECRET',
    updatedAt: '2026-10-10T01:00:00Z',
  },
} as InboxCard;
const native = (canReply: boolean, state = 'parked'): InboxCard =>
  ({
    work: {
      id: 'work:01ABC',
      state,
      spec: { title: 'SECRET' },
      runs: [{ runId: 'work:01ABC/r2' }],
    },
    canReply,
  }) as InboxCard;

describe('notification authorization and privacy', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.snoozes.mockResolvedValue({});
    vi.useFakeTimers();
    vi.setSystemTime(150_000);
    mocks.auth.mockResolvedValue({ user: { id: 'viewer', isAdmin: true } });
    mocks.queue.mockResolvedValue({
      data: { items: [] },
      fetchedAt: new Date().toISOString(),
    });
    mocks.activity.mockResolvedValue({
      data: { recentRuns: [], liveRuns: [], warnings: [] },
      fetchedAt: new Date().toISOString(),
    });
    mocks.sessions.mockResolvedValue({
      sessionsByRunId: new Map(),
      warnings: [],
    });
    mocks.context.mockResolvedValue({ runtime: { store: {} }, principal: {} });
    mocks.native.mockResolvedValue([native(true)]);
  });
  it('requires a currently authenticated admin before any data read', async () => {
    for (const user of [
      null,
      { user: { id: 'viewer', isAdmin: false } },
      { user: { id: '', isAdmin: true } },
    ]) {
      mocks.auth.mockResolvedValue(user);
      await expect(loadInboxNotificationSnapshot()).rejects.toThrow(
        'Unauthorized',
      );
    }
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it('includes only explicit human handoffs and currently permitted native parks', () => {
    const nonHuman = {
      ...github,
      item: {
        ...(github as { item: object }).item,
        actionTypes: ['run-failed'],
      },
    } as InboxCard;
    expect(
      notificationDecisions([
        github,
        nonHuman,
        native(false),
        native(true, 'running'),
        native(true),
      ]),
    ).toEqual([
      { id: 'owner/repo#1', generation: 'needs-human' },
      { id: 'work:01ABC', generation: 'work:01ABC/r2' },
    ]);
  });
  it('rechecks native Work grants and returns identifiers without preview text', async () => {
    const result = await loadInboxNotificationSnapshot();
    expect(result).toMatchObject({
      principalId: 'viewer',
      available: true,
      decisions: [{ id: 'work:01ABC', generation: 'work:01ABC/r2' }],
    });
    expect(result.observedAt).toBe(Date.parse((await mocks.queue()).fetchedAt));
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(mocks.native).toHaveBeenCalledWith({}, {});
  });
  it('honors matching server snoozes and resumes on changed decision signatures', async () => {
    mocks.snoozes.mockResolvedValue({
      'work:01ABC': { signature: inboxCardSignature(native(true)) },
    });
    expect((await loadInboxNotificationSnapshot()).decisions).toEqual([]);
    mocks.snoozes.mockResolvedValue({
      'work:01ABC': { signature: 'earlier-run' },
    });
    expect((await loadInboxNotificationSnapshot()).decisions).toHaveLength(1);
  });
  it('marks stale or degraded evidence unavailable instead of fabricating empty success', async () => {
    mocks.activity.mockResolvedValue({
      data: { recentRuns: [], liveRuns: [], warnings: ['degraded'] },
      fetchedAt: new Date().toISOString(),
    });
    expect((await loadInboxNotificationSnapshot()).available).toBe(false);
    mocks.activity.mockResolvedValue({
      data: { recentRuns: [], liveRuns: [], warnings: [] },
      fetchedAt: '2000-01-01T00:00:00.000Z',
    });
    expect((await loadInboxNotificationSnapshot()).available).toBe(false);
  });
  it.each(['queue', 'activity'] as const)(
    'marks invalid, future and expired %s clocks unavailable',
    async (source) => {
      const value = await mocks[source]();
      for (const fetchedAt of [
        'invalid',
        new Date(150_001).toISOString(),
        new Date(150_000 - NOTIFICATION_FRESH_MS).toISOString(),
      ]) {
        mocks[source].mockResolvedValue({ ...value, fetchedAt });
        const snapshot = await loadInboxNotificationSnapshot();
        expect(snapshot.available).toBe(false);
        const state = { ...emptyNotificationState(), enabled: true };
        expect(advanceNotificationState(state, snapshot, 150_000)).toBe(state);
      }
    },
  );
  it('keeps cached source vectors through the loader and rejects a false mixed-source reopening', async () => {
    mocks.native.mockResolvedValue([]);
    const load = async (
      queueAt: number,
      activityAt: number,
      present: boolean,
    ) => {
      mocks.queue.mockResolvedValue({
        data: { items: present ? [(github as { item: object }).item] : [] },
        fetchedAt: new Date(queueAt).toISOString(),
      });
      mocks.activity.mockResolvedValue({
        data: { recentRuns: [], liveRuns: [], warnings: [] },
        fetchedAt: new Date(activityAt).toISOString(),
      });
      return loadInboxNotificationSnapshot();
    };
    const baseline = await load(100_000, 100_000, true);
    let state = advanceNotificationState(
      { ...emptyNotificationState(), enabled: true },
      baseline,
      Date.now(),
    );
    expect(state.active).toEqual([
      { id: 'owner/repo#1', generation: 'needs-human' },
    ]);
    const absent = await load(130_000, 100_000, false);
    state = advanceNotificationState(state, absent, Date.now());
    expect(state.active).toEqual([]);

    // The minimum advances even though the queue regresses: scalar ordering
    // would incorrectly notify this cached presence as a reopening.
    vi.setSystemTime(151_000);
    const olderPresence = await load(110_000, 140_000, true);
    expect(olderPresence).toMatchObject({
      available: true,
      observedAt: 110_000,
      sourceTimes: { queue: 110_000, activity: 140_000, native: 151_000 },
    });
    expect(advanceNotificationState(state, olderPresence, Date.now())).toBe(
      state,
    );
    expect(state.pending).toEqual([]);

    vi.setSystemTime(152_000);
    const reopened = await load(140_000, 140_000, true);
    state = advanceNotificationState(state, reopened, Date.now());
    expect(state.pending).toEqual(baseline.decisions);
    expect(state.sourceTimes).toEqual(reopened.sourceTimes);
    expect(advanceNotificationState(state, reopened, Date.now())).toBe(state);
  });
  it('observes a new permitted native park with unchanged cached GitHub clocks', async () => {
    const first = await loadInboxNotificationSnapshot();
    const state = advanceNotificationState(
      { ...emptyNotificationState(), enabled: true },
      first,
      Date.now(),
    );
    const next = native(true);
    if ('work' in next)
      next.work.runs = [{ ...next.work.runs[0], runId: 'work:01ABC/r3' }];
    mocks.native.mockResolvedValue([next]);
    vi.setSystemTime(151_000);
    const snapshot = await loadInboxNotificationSnapshot();
    expect(snapshot.sourceTimes).toEqual({
      ...first.sourceTimes,
      native: 151_000,
    });
    expect(
      advanceNotificationState(state, snapshot, Date.now()).pending,
    ).toEqual([{ id: 'work:01ABC', generation: 'work:01ABC/r3' }]);
  });
});
