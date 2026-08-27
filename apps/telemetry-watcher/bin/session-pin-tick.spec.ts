import { describe, expect, it, vi } from 'vitest';

import { pinOpenItemSessions } from './session-pin-tick';

function itemsResponse(
  items: { id: string; sessions: { sessionId: string }[] }[],
) {
  return new Response(JSON.stringify({ items }), { status: 200 });
}

describe('pinOpenItemSessions', () => {
  it('touches expireAt for every session of every running or parked item', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        itemsResponse([
          { id: 'A', sessions: [{ sessionId: 's1' }, { sessionId: 's2' }] },
        ]),
      )
      .mockResolvedValueOnce(
        itemsResponse([{ id: 'B', sessions: [{ sessionId: 's3' }] }]),
      );
    const touchExpiry = vi.fn();
    const { pinned } = await pinOpenItemSessions({
      bearer: 'tok',
      now: new Date('2026-08-27T00:00:00.000Z'),
      fetchImpl,
      touchExpiry,
    });
    expect(pinned.sort()).toEqual(['s1', 's2', 's3']);
    expect(touchExpiry).toHaveBeenCalledWith('s1', '2027-08-27T00:00:00.000Z');
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('state=running');
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('state=parked');
  });

  it('touches nothing when both states return no items (a settled item is simply absent)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(itemsResponse([]))
      .mockResolvedValueOnce(itemsResponse([]));
    const touchExpiry = vi.fn();
    const { pinned } = await pinOpenItemSessions({
      bearer: 'tok',
      fetchImpl,
      touchExpiry,
    });
    expect(pinned).toEqual([]);
    expect(touchExpiry).not.toHaveBeenCalled();
  });

  it('throws on a non-ok response rather than silently skipping', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(
      pinOpenItemSessions({ bearer: 'tok', fetchImpl, touchExpiry: vi.fn() }),
    ).rejects.toThrow(/401/);
  });
});
