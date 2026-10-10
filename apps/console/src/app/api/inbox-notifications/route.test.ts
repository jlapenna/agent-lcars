import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../../lib/inbox-notifications-data', () => ({
  loadInboxNotificationSnapshot: mocks.read,
}));
import { GET } from './route';

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('bounded authenticated notification read response', () => {
  it('marks authorized identifier snapshots private and uncacheable', async () => {
    const snapshot = { principalId: 'viewer', decisions: [] };
    mocks.read.mockResolvedValue(snapshot);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual(snapshot);
  });
  it('returns only a generic unavailable response for auth or source failure', async () => {
    mocks.read.mockRejectedValue(new Error('SECRET credential detail'));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Notification source unavailable',
    });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('ends a hung optional HTTP response at the server deadline without leaking late data', async () => {
    vi.useFakeTimers();
    let resolve: ((value: unknown) => void) | undefined;
    mocks.read.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const result = GET();
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await result;
    expect(response.status).toBe(503);
    resolve?.({ principalId: 'late', decisions: ['SECRET'] });
    expect(await response.json()).toEqual({
      error: 'Notification source unavailable',
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
