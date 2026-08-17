import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  e2eTesting: true,
  getActionItems: vi.fn(),
  getAgentActivity: vi.fn(),
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

vi.mock('@agent-lcars/util-server', () => ({
  isE2eTesting: () => mocks.e2eTesting,
}));
vi.mock('next/cache', () => ({
  cacheLife: mocks.cacheLife,
  cacheTag: mocks.cacheTag,
}));
vi.mock('./action-items', () => ({ getActionItems: mocks.getActionItems }));
vi.mock('./agent-activity', () => ({
  getAgentActivity: mocks.getAgentActivity,
}));

const { getCachedActionItems, getCachedAgentActivity } =
  // eslint-disable-next-line no-restricted-syntax -- imported dynamically so it evaluates AFTER the vi.mock factories above; a static import would bind the unmocked module.
  await import('./dashboard-data');

describe('dashboard data cache boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.e2eTesting = true;
  });

  it('reads every E2E fixture generation fresh without entering Next cache', async () => {
    mocks.getActionItems
      .mockResolvedValueOnce({ items: [{ number: 20001, title: 'body A' }] })
      .mockResolvedValueOnce({ items: [{ number: 20001, title: 'body B' }] });
    mocks.getAgentActivity
      .mockResolvedValueOnce({ recentRuns: [{ id: 1 }] })
      .mockResolvedValueOnce({ recentRuns: [{ id: 2 }] });

    const firstItems = await getCachedActionItems();
    const secondItems = await getCachedActionItems();
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
    expect(mocks.cacheTag).not.toHaveBeenCalled();
    expect(mocks.cacheLife).not.toHaveBeenCalled();
  });

  it('retains the existing cache policy outside E2E', async () => {
    mocks.e2eTesting = false;
    mocks.getActionItems.mockResolvedValue({ items: [] });
    mocks.getAgentActivity.mockResolvedValue({ recentRuns: [] });

    await getCachedActionItems();
    await getCachedAgentActivity();

    expect(mocks.cacheTag).toHaveBeenCalledTimes(2);
    expect(mocks.cacheTag).toHaveBeenNthCalledWith(1, 'github-data');
    expect(mocks.cacheTag).toHaveBeenNthCalledWith(2, 'github-data');
    expect(mocks.cacheLife).toHaveBeenCalledTimes(2);
  });
});
