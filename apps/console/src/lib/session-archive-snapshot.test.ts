import { randomBytes } from 'node:crypto';

import type { SessionDoc } from '@agent-lcars/telemetry';
import { type Firestore, Timestamp } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';

import {
  decodeSnapshotDocs,
  encodeSnapshotDocs,
  loadArchiveSnapshot,
  saveArchiveSnapshot,
  SNAPSHOT_COLLECTION,
} from './session-archive-snapshot';

const session = (sessionId: string, title = 'Fix the thing'): SessionDoc =>
  ({
    sessionId,
    source: 'cli',
    agent: 'claude-code',
    liveness: 'ended',
    startedAt: '2026-11-24T10:00:00.000Z',
    lastActivityAt: '2026-11-24T11:00:00.000Z',
    expireAt: '2026-12-24T11:00:00.000Z',
    turns: 3,
    title,
    toolCallCounts: { Bash: 2 },
    tokens: {
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 0,
      cacheReadTokens: 5,
    },
    deliverables: { prNumbers: [], commitShas: [] },
  }) as SessionDoc;

/** Enough incompressible text to need more than one 900 KB chunk. */
const largeDocs = () =>
  Array.from({ length: 2_500 }, (_, index) =>
    session(`s-${index}`, randomBytes(600).toString('base64')),
  );

/** The slice of Firestore the snapshot uses: batch writes and a read-only
 * transaction's getAll over one collection. */
function fakeFirestore() {
  const store = new Map<string, Record<string, unknown>>();
  const ref = (id: string) => ({ id });
  const firestore = {
    collection: (name: string) => {
      expect(name).toBe(SNAPSHOT_COLLECTION);
      return { doc: ref };
    },
    batch: () => {
      const ops: (() => void)[] = [];
      return {
        set: (doc: { id: string }, data: Record<string, unknown>) =>
          // Shallow: Firestore returns Timestamps and bytes as their types.
          ops.push(() => store.set(doc.id, { ...data })),
        delete: (doc: { id: string }) => ops.push(() => store.delete(doc.id)),
        commit: async () => ops.forEach((op) => op()),
      };
    },
    runTransaction: async (
      fn: (transaction: unknown) => Promise<unknown>,
      options: { readOnly?: boolean },
    ) => {
      expect(options).toEqual({ readOnly: true });
      return fn({
        getAll: async (...docs: { id: string }[]) =>
          docs.map((doc) => ({ data: () => store.get(doc.id) })),
      });
    },
  };
  return { firestore: firestore as unknown as Firestore, store };
}

describe('session archive snapshot', () => {
  it('round-trips the session list through gzip chunks', () => {
    const docs = largeDocs();
    const encoded = encodeSnapshotDocs(docs);
    expect(encoded.chunks.length).toBeGreaterThan(1);
    expect(decodeSnapshotDocs(encoded.chunks)).toEqual(docs);
  });

  it('saves and loads a snapshot with its watermarks', async () => {
    const { firestore, store } = fakeFirestore();
    const writtenSince = Timestamp.fromMillis(1_700_000_000_000);
    const docs = largeDocs();

    await saveArchiveSnapshot(firestore, {
      docs,
      writtenSince,
      syncedAt: 1_700_000_060_000,
    });
    const loaded = await loadArchiveSnapshot(firestore);

    expect(loaded?.docs).toEqual(docs);
    expect(loaded?.writtenSince.toMillis()).toBe(writtenSince.toMillis());
    expect(loaded?.syncedAt).toBe(1_700_000_060_000);

    // A smaller save clears the slots the larger one used.
    await saveArchiveSnapshot(firestore, {
      docs: [session('only')],
      writtenSince,
      syncedAt: 1_700_000_120_000,
    });
    expect([...store.keys()].sort()).toEqual(['chunk-0', 'manifest']);
    expect((await loadArchiveSnapshot(firestore))?.docs).toEqual([
      session('only'),
    ]);
  });

  it('has nothing to load before the first save', async () => {
    expect(await loadArchiveSnapshot(fakeFirestore().firestore)).toBe(
      undefined,
    );
  });

  it('refuses chunks from a different save than the manifest', async () => {
    const { firestore, store } = fakeFirestore();
    await saveArchiveSnapshot(firestore, {
      docs: [session('a')],
      writtenSince: Timestamp.fromMillis(0),
      syncedAt: 1,
    });
    store.set('chunk-0', { ...store.get('chunk-0'), generation: 'other' });

    await expect(loadArchiveSnapshot(firestore)).rejects.toThrow(
      'do not match the manifest',
    );
  });
});
