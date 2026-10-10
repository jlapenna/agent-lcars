import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  queue: vi.fn(),
  activity: vi.fn(),
  sessions: vi.fn(),
  native: vi.fn(),
  context: vi.fn(),
}));
vi.mock('../auth', () => ({ auth: mocks.auth }));
vi.mock('./dashboard-data', () => ({
  getCachedQueueItems: mocks.queue,
  getCachedAgentActivity: mocks.activity,
  oldestFetchedAt: (...times: string[]) => times.sort()[0],
}));
vi.mock('./runner-sessions', () => ({
  getRunnerSessionsByRunId: mocks.sessions,
}));
vi.mock('./native-inbox', () => ({ getNativeInboxCards: mocks.native }));
vi.mock('../app/work/context', () => ({ context: mocks.context }));
import type { InboxCard } from '../app/inbox-card';
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
  beforeEach(() => {
    vi.resetAllMocks();
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
});
