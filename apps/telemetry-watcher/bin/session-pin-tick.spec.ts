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

  // Review thread PRRT_kwDOTemFxc6c7mZ4: MAX_PAGES bounds items
  // *traversed*, not the one extra request that proves a full last page
  // was actually the end. When history is exactly `PAGE_LIMIT * MAX_PAGES`
  // items long, the MAX_PAGES-th page is full and (per itemsContract.list)
  // still carries a `nextCursor` even though nothing remains -- an
  // `(MAX_PAGES + 1)`-th "exhaustion probe" request per state must be
  // allowed to come back empty with no cursor, rather than the sweep
  // throwing on a cursor that was always going to be there.
  it('completes without throwing when history is exactly PAGE_LIMIT * MAX_PAGES items long (the last page is full and still carries a cursor)', async () => {
    // Modeling this with real PAGE_LIMIT-sized item arrays would mean
    // allocating 100,000 objects per state; the loop only ever inspects
    // whether `nextCursor` is present, never how many items came back, so
    // a page count keyed off the request's own `state` is a cleaner seam
    // than a real-sized fixture.
    const callsByState: Record<string, number> = { running: 0, parked: 0 };
    const fetchImpl = vi.fn().mockImplementation(async (input: string) => {
      const state = new URL(input).searchParams.get('state') as string;
      callsByState[state] = (callsByState[state] ?? 0) + 1;
      const call = callsByState[state] ?? 0;
      if (call <= MAX_PAGES) {
        // A full page: still carries a cursor per itemsContract.list's
        // contract, even on the MAX_PAGES-th (final, boundary) page.
        return itemsResponse([], `CURSOR_${state}_${call}`);
      }
      // The exhaustion probe: nothing left, no cursor.
      return itemsResponse([]);
    });
    const { pinned } = await pinOpenItemSessions({
      bearer: 'tok',
      fetchImpl,
      touchExpiry: vi.fn(),
    });
    expect(pinned).toEqual([]);
    // MAX_PAGES full pages plus one exhaustion probe, per state.
    expect(callsByState['running']).toBe(MAX_PAGES + 1);
    expect(callsByState['parked']).toBe(MAX_PAGES + 1);
  });

  it('aborts each state rather than scanning forever if the backend keeps answering nextCursor, but still runs every state', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => itemsResponse([], 'ALWAYS_MORE'));
    const rejection = await pinOpenItemSessions({
      bearer: 'tok',
      fetchImpl,
      touchExpiry: vi.fn(),
    }).catch((error: unknown) => error as Error);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/nextCursor/);
    // Both states are named as failed -- a persistently-misbehaving
    // backend fails `running` AND `parked`, not just the first one tried.
    expect((rejection as Error).message).toMatch(/running/);
    expect((rejection as Error).message).toMatch(/parked/);
    // Bounded, not infinite: MAX_PAGES full pages plus one exhaustion
    // probe per state (see the boundary test above) -- for BOTH states,
    // since a persistent failure in `running` must not skip `parked`.
    expect(fetchImpl).toHaveBeenCalledTimes((MAX_PAGES + 1) * 2);
  });

  // Review thread PRRT_kwDOTemFxc6c7mZ4's second finding: the two states'
  // passes must be independent. A throw while sweeping `running` must not
  // prevent `parked` from running at all -- that coupling would silently
  // leave a whole state's sessions unpinned (the same shape of bug as
  // incident #1548's silent drain failure), and the job must still exit
  // in failure overall rather than swallowing the `running` error.
  it('runs the parked pass even when the running pass fails, and still fails the job overall', async () => {
    const fetchImpl = vi
      .fn()
      // `running`: the backend errors outright.
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      // `parked`: succeeds normally, one page, done.
      .mockResolvedValueOnce(
        itemsResponse([{ id: 'P', sessions: [{ sessionId: 's-parked' }] }]),
      );
    const touchExpiry = vi.fn();

    const rejection = await pinOpenItemSessions({
      bearer: 'tok',
      now: new Date('2026-08-27T00:00:00.000Z'),
      fetchImpl,
      touchExpiry,
    }).catch((error: unknown) => error as Error);

    // The job still fails loudly overall...
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/running/);
    expect((rejection as Error).message).toMatch(/500/);
    // ...but the parked pass still ran and pinned its session, proving
    // the running failure did not short-circuit it.
    expect(touchExpiry).toHaveBeenCalledWith(
      's-parked',
      '2027-08-27T00:00:00.000Z',
    );
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('state=parked');
  });
});
