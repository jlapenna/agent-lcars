import { ISSUE_AGENT_SESSION_RETENTION_DAYS } from '@agent-lcars/telemetry';
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
    // A dropped bearer or a dropped limit should fail a test, not just
    // 401/mis-scope in production.
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('limit=200');
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('limit=200');
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual({
      headers: { authorization: 'Bearer tok' },
    });
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual({
      headers: { authorization: 'Bearer tok' },
    });
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

  it("pins its local RETENTION_DAYS to session-doc.ts's ISSUE_AGENT_SESSION_RETENTION_DAYS", async () => {
    // session-pin-tick.ts's RETENTION_DAYS is a hand-synced local literal
    // (see its own comment), not an import -- this pins the two together
    // by asserting the actual retention horizon it touches sessions
    // forward to matches the shared constant, not just the literal 365.
    const now = new Date('2026-08-27T00:00:00.000Z');
    const expireAt = new Date(
      now.getTime() + ISSUE_AGENT_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        itemsResponse([{ id: 'A', sessions: [{ sessionId: 's1' }] }]),
      )
      .mockResolvedValueOnce(itemsResponse([]));
    const touchExpiry = vi.fn();
    await pinOpenItemSessions({ bearer: 'tok', now, fetchImpl, touchExpiry });
    expect(touchExpiry).toHaveBeenCalledWith('s1', expireAt);
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
