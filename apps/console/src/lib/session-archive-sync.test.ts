import type { SessionDoc } from '@agent-lcars/telemetry';
import { Timestamp } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';

import { createSessionArchiveSync } from './session-archive-sync';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const minutesAgo = (minutes: number) =>
  new Date(NOW - minutes * 60_000).toISOString();

const session = (sessionId: string, lastActivityAt: string, turns = 1) =>
  ({ sessionId, lastActivityAt, turns }) as SessionDoc;

function harness() {
  let now = NOW;
  const listActiveSince = vi.fn<(since: string) => Promise<SessionDoc[]>>();
  const listWrittenSince =
    vi.fn<
      (since: Timestamp) => Promise<{ docs: SessionDoc[]; readTime: Timestamp }>
    >();
  const sync = createSessionArchiveSync(
    { listActiveSince, listWrittenSince, now: () => now },
    14,
  );
  return {
    sync,
    listActiveSince,
    listWrittenSince,
    advance: (ms: number) => (now += ms),
  };
}

describe('createSessionArchiveSync', () => {
  it('loads the window once, then reads only what was written since', async () => {
    const h = harness();
    h.listActiveSince.mockResolvedValueOnce([
      session('a', minutesAgo(30)),
      session('b', minutesAgo(5)),
    ]);
    expect((await h.sync.read(14)).map((doc) => doc.sessionId)).toEqual([
      'b',
      'a',
    ]);
    expect(h.listActiveSince).toHaveBeenCalledWith(
      new Date(NOW - 14 * 86_400_000).toISOString(),
    );
    expect(h.listWrittenSince).not.toHaveBeenCalled();

    h.advance(60_000);
    const readTime = Timestamp.fromMillis(NOW + 60_000);
    h.listActiveSince.mockResolvedValueOnce([]);
    h.listWrittenSince.mockResolvedValueOnce({
      docs: [session('a', minutesAgo(30), 7), session('c', minutesAgo(0))],
      readTime,
    });
    const docs = await h.sync.read(14);
    expect(docs.map((doc) => [doc.sessionId, doc.turns])).toEqual([
      ['c', 1],
      ['b', 1],
      ['a', 7],
    ]);
    // The first incremental read reaches back past the load's start, so a
    // write committed while the window was loading is not skipped.
    expect(h.listWrittenSince.mock.calls[0]![0].toMillis()).toBeLessThan(NOW);

    h.advance(60_000);
    h.listActiveSince.mockResolvedValueOnce([]);
    h.listWrittenSince.mockResolvedValueOnce({ docs: [], readTime });
    await h.sync.read(14);
    expect(h.listWrittenSince.mock.calls[1]![0]).toBe(readTime);
  });

  it('catches writers that do not stamp writtenAt by recent activity', async () => {
    const h = harness();
    h.listActiveSince.mockResolvedValueOnce([session('a', minutesAgo(2))]);
    await h.sync.read(1);

    h.advance(60_000);
    h.listActiveSince.mockResolvedValueOnce([session('a', minutesAgo(0), 3)]);
    h.listWrittenSince.mockResolvedValueOnce({
      docs: [],
      readTime: Timestamp.fromMillis(NOW + 60_000),
    });
    expect((await h.sync.read(1))[0]?.turns).toBe(3);
    expect(h.listActiveSince).toHaveBeenLastCalledWith(
      new Date(NOW - 15 * 60_000).toISOString(),
    );
  });

  it('answers a narrower window and drops sessions that leave the held one', async () => {
    const h = harness();
    h.listActiveSince.mockResolvedValueOnce([
      session('old', new Date(NOW - 13.99 * 86_400_000).toISOString()),
      session('new', minutesAgo(1)),
    ]);
    expect((await h.sync.read(1)).map((doc) => doc.sessionId)).toEqual(['new']);

    h.advance(3_600_000);
    h.listActiveSince.mockResolvedValueOnce([]);
    h.listWrittenSince.mockResolvedValueOnce({
      docs: [],
      readTime: Timestamp.fromMillis(NOW),
    });
    expect((await h.sync.read(14)).map((doc) => doc.sessionId)).toEqual([
      'new',
    ]);
  });

  it('shares one refresh between concurrent reads', async () => {
    const h = harness();
    h.listActiveSince.mockResolvedValueOnce([session('a', minutesAgo(1))]);
    await Promise.all([h.sync.read(14), h.sync.read(1)]);
    expect(h.listActiveSince).toHaveBeenCalledTimes(1);
  });

  it('fails a read rather than answer from an older copy, then recovers', async () => {
    const h = harness();
    h.listActiveSince.mockResolvedValueOnce([session('a', minutesAgo(1))]);
    await h.sync.read(14);

    h.listActiveSince.mockResolvedValueOnce([]);
    h.listWrittenSince.mockRejectedValueOnce(new Error('unavailable'));
    await expect(h.sync.read(14)).rejects.toThrow('unavailable');

    h.listActiveSince.mockResolvedValueOnce([]);
    h.listWrittenSince.mockResolvedValueOnce({
      docs: [session('b', minutesAgo(0))],
      readTime: Timestamp.fromMillis(NOW),
    });
    expect((await h.sync.read(14)).map((doc) => doc.sessionId)).toEqual([
      'b',
      'a',
    ]);
  });

  it('refuses a window wider than it holds', async () => {
    await expect(harness().sync.read(15)).rejects.toThrow(RangeError);
  });
});
