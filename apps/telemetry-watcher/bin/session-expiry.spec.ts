import { ISSUE_AGENT_SESSION_RETENTION_DAYS } from '@agent-lcars/telemetry';
import { describe, expect, it, vi } from 'vitest';

import {
  clearOpenItemSessionExpiry,
  MAX_PAGES,
  settleItemSessionExpiry,
} from './session-expiry';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function item(state: string, sessionIds: string[]) {
  return {
    id: 'ITEM',
    state,
    sessions: sessionIds.map((sessionId) => ({ sessionId })),
  };
}

describe('settleItemSessionExpiry', () => {
  const now = new Date('2026-10-05T00:00:00.000Z');
  const horizon = new Date(
    now.getTime() + ISSUE_AGENT_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  it.each(['done', 'failed', 'canceled'])(
    'stamps every session of a %s item with close time plus the issue-agent retention',
    async (state) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(json(item(state, ['s1', 's2'])));
      const setExpiry = vi.fn().mockResolvedValue(true);

      const result = await settleItemSessionExpiry('ITEM', {
        bearer: 'tok',
        consoleUrl: 'https://console.test',
        now,
        fetchImpl,
        setExpiry,
      });

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://console.test/api/work/v1/items/ITEM',
        { headers: { authorization: 'Bearer tok' } },
      );
      expect(setExpiry.mock.calls).toEqual([
        ['s1', horizon],
        ['s2', horizon],
      ]);
      expect(result).toEqual({
        itemId: 'ITEM',
        state,
        expireAt: horizon,
        sessions: ['s1', 's2'],
      });
    },
  );

  it.each(['running', 'parked'])(
    'clears expireAt when the item is %s again by the time the workflow runs',
    async (state) => {
      const setExpiry = vi.fn().mockResolvedValue(true);

      const result = await settleItemSessionExpiry('ITEM', {
        bearer: 'tok',
        fetchImpl: vi.fn().mockResolvedValue(json(item(state, ['s1']))),
        setExpiry,
      });

      expect(setExpiry).toHaveBeenCalledWith('s1', null);
      expect(result.expireAt).toBeNull();
    },
  );

  it('reports only sessions whose doc still exists', async () => {
    const setExpiry = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await settleItemSessionExpiry('ITEM', {
      bearer: 'tok',
      fetchImpl: vi.fn().mockResolvedValue(json(item('done', ['gone', 's2']))),
      setExpiry,
    });

    expect(result.sessions).toEqual(['s2']);
  });

  it('fails loudly when the item cannot be read', async () => {
    await expect(
      settleItemSessionExpiry('ITEM', {
        bearer: 'tok',
        fetchImpl: vi.fn().mockResolvedValue(json({}, 401)),
        setExpiry: vi.fn(),
      }),
    ).rejects.toThrow('GET /items/ITEM -> 401');
  });
});

describe('clearOpenItemSessionExpiry', () => {
  it('clears every session of every running and parked item across pages', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json({ items: [item('running', ['s1'])], nextCursor: 'c1' }),
      )
      .mockResolvedValueOnce(json({ items: [item('running', ['s2'])] }))
      .mockResolvedValueOnce(json({ items: [item('parked', ['s3'])] }));
    const setExpiry = vi.fn().mockResolvedValue(true);

    const { cleared } = await clearOpenItemSessionExpiry({
      bearer: 'tok',
      fetchImpl,
      setExpiry,
    });

    expect(cleared).toEqual(['s1', 's2', 's3']);
    expect(
      setExpiry.mock.calls.every(([, expireAt]) => expireAt === null),
    ).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('state=running');
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('limit=200');
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('cursor=c1');
    expect(fetchImpl.mock.calls[2]?.[0]).toContain('state=parked');
  });

  it('still sweeps parked when running fails, then fails the run', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({ items: [item('parked', ['s3'])] }));
    const setExpiry = vi.fn().mockResolvedValue(true);

    await expect(
      clearOpenItemSessionExpiry({ bearer: 'tok', fetchImpl, setExpiry }),
    ).rejects.toThrow('1/2 state(s): running');
    expect(setExpiry).toHaveBeenCalledWith('s3', null);
  });

  it('stops a cursor that never ends after the page bound plus one probe', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('state=running')
        ? json({ items: [], nextCursor: 'again' })
        : json({ items: [] }),
    );

    await expect(
      clearOpenItemSessionExpiry({
        bearer: 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        setExpiry: vi.fn(),
      }),
    ).rejects.toThrow('kept returning nextCursor');
    expect(
      fetchImpl.mock.calls.filter(([url]) => url.includes('state=running')),
    ).toHaveLength(MAX_PAGES + 1);
  });
});
