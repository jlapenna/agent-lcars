import { ISSUE_AGENT_SESSION_RETENTION_DAYS } from '@agent-lcars/telemetry';
import { describe, expect, it, vi } from 'vitest';

import { MAX_PAGES, pinOpenItemSessions } from './session-pin-tick';

function itemsResponse(
  items: { id: string; sessions: { sessionId: string }[] }[],
  nextCursor?: string,
) {
  return new Response(
    JSON.stringify({
      items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }),
    { status: 200 },
  );
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

  // The load-bearing regression test for issue #1546: `list` filters by
  // state AFTER reading only a `limit`-bounded page ordered by creation,
  // so a still-open item created before a run of newer, already-settled
  // ones sits entirely on a later page. A sweep that stops at the first
  // page -- which is exactly what this file did before -- never reaches
  // it, and that item's session ages out at the 365-day TTL. This proves
  // the sweep now follows `nextCursor` rather than reading only page one.
  it('touches a session whose item sits beyond the first page, reached only via nextCursor', async () => {
    const fetchImpl = vi
      .fn()
      // page 1 of `state=running`: only newer, already-settled work --
      // nothing running on this page, but more of the fleet's history
      // remains unread, so the real API would still answer nextCursor.
      .mockResolvedValueOnce(itemsResponse([], 'CURSOR_AFTER_PAGE_1'))
      // page 2 of `state=running`, reached only by sending the cursor
      // above back as `cursor`: the actually-open item lives here.
      .mockResolvedValueOnce(
        itemsResponse([
          { id: 'old-running-item', sessions: [{ sessionId: 's-old' }] },
        ]),
      )
      // `state=parked`: nothing, one page, done.
      .mockResolvedValueOnce(itemsResponse([]));
    const touchExpiry = vi.fn();

    const { pinned } = await pinOpenItemSessions({
      bearer: 'tok',
      now: new Date('2026-08-27T00:00:00.000Z'),
      fetchImpl,
      touchExpiry,
    });

    expect(pinned).toEqual(['s-old']);
    expect(touchExpiry).toHaveBeenCalledWith(
      's-old',
      '2027-08-27T00:00:00.000Z',
    );
    // The second call must actually carry the cursor the first call
    // handed back -- not just any second call.
    expect(fetchImpl.mock.calls[1]?.[0]).toContain(
      'cursor=CURSOR_AFTER_PAGE_1',
    );
  });

  it('aborts rather than scanning forever if the backend keeps answering nextCursor', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => itemsResponse([], 'ALWAYS_MORE'));
    await expect(
      pinOpenItemSessions({ bearer: 'tok', fetchImpl, touchExpiry: vi.fn() }),
    ).rejects.toThrow(/nextCursor/);
    // Bounded, not infinite: exactly MAX_PAGES requests for the first
    // state (`running`) before it gives up, never reaching `parked`.
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_PAGES);
  });
});
