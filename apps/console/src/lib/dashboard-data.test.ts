import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthoritativeQueueItems: vi.fn(),
  getAgentActivity: vi.fn(),
}));

vi.mock('./authoritative-queue', () => ({
  getAuthoritativeQueueItems: mocks.getAuthoritativeQueueItems,
}));
vi.mock('./agent-activity', () => ({
  getAgentActivity: mocks.getAgentActivity,
}));

const { getCachedQueueItems, getCachedAgentActivity } =
  // eslint-disable-next-line no-restricted-syntax -- imported dynamically so it evaluates AFTER the vi.mock factories above; a static import would bind the unmocked module.
  await import('./dashboard-data');

describe('dashboard data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the queue and agent activity fresh outside a render', async () => {
    mocks.getAuthoritativeQueueItems
      .mockResolvedValueOnce({ items: [{ number: 20001, title: 'body A' }] })
      .mockResolvedValueOnce({ items: [{ number: 20001, title: 'body B' }] });
    mocks.getAgentActivity
      .mockResolvedValueOnce({ recentRuns: [{ id: 1 }] })
      .mockResolvedValueOnce({ recentRuns: [{ id: 2 }] });

    const firstItems = await getCachedQueueItems();
    const secondItems = await getCachedQueueItems();
    const firstActivity = await getCachedAgentActivity();
    const secondActivity = await getCachedAgentActivity();

    expect(firstItems.data).toEqual({
      items: [{ number: 20001, title: 'body A' }],
    });
    expect(secondItems.data).toEqual({
      items: [{ number: 20001, title: 'body B' }],
    });
    expect(firstActivity.data).toEqual({ recentRuns: [{ id: 1 }] });
    expect(secondActivity.data).toEqual({ recentRuns: [{ id: 2 }] });
    expect(Date.parse(secondActivity.fetchedAt)).toBeGreaterThanOrEqual(
      Date.parse(firstActivity.fetchedAt),
    );
  });
});
