import type { SessionDoc } from '@agent-lcars/telemetry';
import { Timestamp } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';

import {
  type ArchiveSnapshot,
  createSessionArchiveSync,
  SNAPSHOT_INTERVAL_MS,
} from './session-archive-sync';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const minutesAgo = (minutes: number) =>
  new Date(NOW - minutes * 60_000).toISOString();

const session = (sessionId: string, lastActivityAt: string, turns = 1) =>
  ({ sessionId, lastActivityAt, turns }) as SessionDoc;

function harness(
  snapshots: {
    load?: () => Promise<ArchiveSnapshot | undefined>;
    save?: (snapshot: ArchiveSnapshot) => Promise<void>;
  } = {},
) {
  let now = NOW;
  const listActiveSince = vi.fn<(since: string) => Promise<SessionDoc[]>>();
  const listWrittenSince =
    vi.fn<
      (since: Timestamp) => Promise<{ docs: SessionDoc[]; readTime: Timestamp }>
    >();
  const onSnapshotError = vi.fn();
  const sync = createSessionArchiveSync(
    {
      listActiveSince,
      listWrittenSince,
      now: () => now,
      ...(snapshots.load && { loadSnapshot: snapshots.load }),
      ...(snapshots.save && { saveSnapshot: snapshots.save }),
      onSnapshotError,
    },
    14,
  );
  return {
    sync,
    listActiveSince,
    listWrittenSince,
    onSnapshotError,
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

  describe('snapshots', () => {
    const written = (docs: SessionDoc[] = []) => ({
      docs,
      readTime: Timestamp.fromMillis(NOW),
    });

    it('starts a cold instance from the snapshot and resumes from its watermarks', async () => {
      const snapshotWrittenSince = Timestamp.fromMillis(NOW - 600_000);
      const h = harness({
        load: async () => ({
          docs: [session('a', minutesAgo(30)), session('b', minutesAgo(20))],
          writtenSince: snapshotWrittenSince,
          syncedAt: NOW - 600_000,
        }),
      });
      h.listActiveSince.mockResolvedValueOnce([session('c', minutesAgo(1))]);
      h.listWrittenSince.mockResolvedValueOnce(
        written([session('a', minutesAgo(30), 9)]),
      );

      const docs = await h.sync.read(14);

      expect(docs.map((doc) => [doc.sessionId, doc.turns])).toEqual([
        ['c', 1],
        ['b', 1],
        ['a', 9],
      ]);
      // Never the whole window: only what changed since the snapshot.
      expect(h.listActiveSince).toHaveBeenCalledTimes(1);
      expect(h.listActiveSince).toHaveBeenCalledWith(
        new Date(NOW - 600_000 - 15 * 60_000).toISOString(),
      );
      expect(h.listWrittenSince).toHaveBeenCalledWith(snapshotWrittenSince);
    });

    it('loads the window when the snapshot is missing, unreadable or older than the window', async () => {
      for (const load of [
        async () => undefined,
        async () => {
          throw new Error('unreadable');
        },
        async () => ({
          docs: [],
          writtenSince: Timestamp.fromMillis(0),
          syncedAt: NOW - 15 * 86_400_000,
        }),
      ]) {
        const h = harness({ load });
        h.listActiveSince.mockResolvedValueOnce([session('a', minutesAgo(1))]);
        expect((await h.sync.read(14)).map((doc) => doc.sessionId)).toEqual([
          'a',
        ]);
        expect(h.listActiveSince).toHaveBeenCalledWith(
          new Date(NOW - 14 * 86_400_000).toISOString(),
        );
        expect(h.listWrittenSince).not.toHaveBeenCalled();
      }
    });

    it('saves a current view at most once per interval without delaying the read', async () => {
      const saved: ArchiveSnapshot[] = [];
      let release: () => void = () => undefined;
      const h = harness({
        save: (snapshot) => {
          saved.push(snapshot);
          return new Promise((resolve) => (release = resolve));
        },
      });
      h.listActiveSince.mockResolvedValue([session('a', minutesAgo(1))]);
      h.listWrittenSince.mockResolvedValue(written());

      // The read resolves while the save is still pending.
      await h.sync.read(14);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ syncedAt: NOW });
      expect(saved[0]?.docs.map((doc) => doc.sessionId)).toEqual(['a']);

      h.advance(60_000);
      await h.sync.read(14);
      expect(saved).toHaveLength(1);

      h.advance(SNAPSHOT_INTERVAL_MS);
      await h.sync.read(14);
      expect(saved).toHaveLength(2);
      expect(saved[1]?.writtenSince).toEqual(Timestamp.fromMillis(NOW));
      release();
    });

    it('reports a failed save and keeps serving reads', async () => {
      const h = harness({
        save: async () => {
          throw new Error('quota');
        },
      });
      h.listActiveSince.mockResolvedValue([session('a', minutesAgo(1))]);

      await h.sync.read(14);
      await vi.waitFor(() =>
        expect(h.onSnapshotError).toHaveBeenCalledWith(
          'save',
          expect.any(Error),
        ),
      );
    });
  });
});
