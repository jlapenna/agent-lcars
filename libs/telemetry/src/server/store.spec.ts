import { Timestamp } from '@google-cloud/firestore';
import { getApps, initializeApp } from 'firebase-admin/app';
import {
  FieldValue,
  Firestore,
  getFirestore as getAdminFirestore,
} from 'firebase-admin/firestore';
import { FakeFirestore } from 'firestore-jest-mock';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { SessionDoc, SessionWrite } from '../lib/types';
import {
  _resetForTesting,
  backfillSessionSpend,
  getAgentTelemetryWriterFirestore,
  listSessionDocsWrittenSince,
  setSessionExpiry,
  upsertSession,
} from './store';

vi.mock('firebase-admin/app', () => ({
  getApps: vi.fn().mockReturnValue([]),
  initializeApp: vi.fn().mockReturnValue({}),
}));

vi.mock('firebase-admin/firestore', async () => ({
  getFirestore: vi.fn(),
  Timestamp: (await vi.importActual('@google-cloud/firestore')).Timestamp,
  FieldValue: (await vi.importActual('@google-cloud/firestore')).FieldValue,
  FieldPath: (await vi.importActual('@google-cloud/firestore')).FieldPath,
}));

vi.mock('@agent-lcars/util-server', async () => ({
  ...(await vi.importActual('@agent-lcars/util-server')),
  isEmulator: vi.fn().mockReturnValue(false),
  getProjectId: vi.fn().mockReturnValue('test-project'),
  getFirestoreEmulatorHost: vi.fn().mockReturnValue(undefined),
}));

function sessionDoc(overrides: Partial<SessionDoc> = {}): SessionDoc {
  return {
    sessionId: 'session-1',
    source: 'cli',
    liveness: 'live',
    startedAt: '2026-07-10T10:00:00.000Z',
    lastActivityAt: '2026-07-10T10:05:00.000Z',
    expireAt: '2026-08-09T10:05:00.000Z',
    turns: 1,
    toolCallCounts: {},
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    ...overrides,
  } as SessionDoc;
}

function sessionWrite(
  overrides: Partial<SessionDoc> = {},
  clearFields: SessionWrite['clearFields'] = [],
): SessionWrite {
  return { doc: sessionDoc(overrides), clearFields };
}

describe('agent-telemetry store', () => {
  let fakeFirestore: Firestore;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    fakeFirestore = new FakeFirestore(
      {},
      { mutable: true },
    ) as unknown as Firestore;
    (getApps as Mock).mockReturnValue([]);
    (initializeApp as Mock).mockReturnValue({});
    (getAdminFirestore as Mock).mockReturnValue(fakeFirestore);
  });

  describe('getAgentTelemetryWriterFirestore', () => {
    it('uses the isolated project default database', () => {
      getAgentTelemetryWriterFirestore();

      expect(getAdminFirestore).toHaveBeenCalledWith(
        expect.anything(),
        '(default)',
      );
    });

    it('caches the client across calls instead of re-initializing', () => {
      const a = getAgentTelemetryWriterFirestore();
      const b = getAgentTelemetryWriterFirestore();

      expect(a).toBe(b);
      expect(getAdminFirestore).toHaveBeenCalledTimes(1);
      expect(initializeApp).toHaveBeenCalledTimes(1);
    });

    it('reuses an already-initialized app rather than creating a new one', () => {
      (getApps as Mock).mockReturnValue([{ name: '[DEFAULT]' }]);

      getAgentTelemetryWriterFirestore();

      expect(initializeApp).not.toHaveBeenCalled();
    });
  });

  describe('upsertSession', () => {
    it('writes a session doc at sessions/{sessionId}', async () => {
      const doc = sessionDoc();

      await upsertSession({ doc, clearFields: [] });

      const snap = await fakeFirestore
        .collection('sessions')
        .doc('session-1')
        .get();
      expect(snap.exists).toBe(true);
      expect(snap.data()).toEqual({
        ...doc,
        spend: { tokens: 0, costUsd: 0 },
        expireAt: Timestamp.fromDate(new Date(doc.expireAt as string)),
        writtenAt: expect.anything(),
      });
    });

    it('writes expireAt as a native Firestore Timestamp, not the ISO string', async () => {
      await upsertSession(sessionWrite());

      const snap = await fakeFirestore
        .collection('sessions')
        .doc('session-1')
        .get();
      expect(snap.data()?.['expireAt']).toBeInstanceOf(Timestamp);
    });

    it('merges rather than overwrites on repeated upserts', async () => {
      await upsertSession(sessionWrite({ turns: 1 }));
      await upsertSession(sessionWrite({ turns: 2 }));

      const snap = await fakeFirestore
        .collection('sessions')
        .doc('session-1')
        .get();
      expect(snap.data()?.['turns']).toBe(2);
    });

    it('maps clearFields to FieldValue.delete() sentinels in the write', async () => {
      await upsertSession(sessionWrite({}, ['status', 'statusUpdatedAt']));

      const snap = await fakeFirestore
        .collection('sessions')
        .doc('session-1')
        .get();
      // See apps/telemetry-watcher/src/lib/store.spec.ts's equivalent test
      // for why reference equality against the singleton sentinel is the
      // correct assertion here (FakeFirestore doesn't simulate Firestore's
      // own delete semantics; this store module's job is only to translate
      // clearFields into the right sentinel).
      expect(snap.data()?.['status']).toBe(FieldValue.delete());
      expect(snap.data()?.['statusUpdatedAt']).toBe(FieldValue.delete());
    });

    it('requests no field deletions when clearFields is empty', async () => {
      await upsertSession(sessionWrite());

      const snap = await fakeFirestore
        .collection('sessions')
        .doc('session-1')
        .get();
      expect(snap.data()).not.toHaveProperty('status');
      expect(snap.data()).not.toHaveProperty('statusUpdatedAt');
    });
  });

  describe('setSessionExpiry', () => {
    it('stamps only expireAt, as a native Timestamp, leaving other fields untouched', async () => {
      await upsertSession(sessionWrite({ turns: 3 }));
      const future = new Date('2027-08-27T00:00:00.000Z').toISOString();

      expect(await setSessionExpiry('session-1', future)).toBe(true);

      const snap = await fakeFirestore
        .collection('sessions')
        .doc('session-1')
        .get();
      expect(snap.data()?.['expireAt']).toBeInstanceOf(Timestamp);
      expect(snap.data()?.['expireAt']).toEqual(
        Timestamp.fromDate(new Date(future)),
      );
      expect(snap.data()?.['turns']).toBe(3);
    });

    it('clears expireAt with a field delete so the TTL policy ignores the doc', async () => {
      // firestore-jest-mock's update() ignores delete sentinels, so assert
      // the request itself.
      const update = vi.fn().mockResolvedValue(undefined);
      (getAdminFirestore as Mock).mockReturnValue({
        collection: () => ({ doc: () => ({ update }) }),
      });
      _resetForTesting();

      expect(await setSessionExpiry('session-1', null)).toBe(true);

      expect(update).toHaveBeenCalledOnce();
      const fields = update.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.keys(fields)).toEqual(['expireAt', 'writtenAt']);
      expect(
        (fields['expireAt'] as FieldValue).isEqual(FieldValue.delete()),
      ).toBe(true);
      expect(
        (fields['writtenAt'] as FieldValue).isEqual(
          FieldValue.serverTimestamp(),
        ),
      ).toBe(true);
    });

    it('never resurrects a missing doc', async () => {
      const update = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('gone'), { code: 5 }));
      (getAdminFirestore as Mock).mockReturnValue({
        collection: () => ({ doc: () => ({ update }) }),
      });
      _resetForTesting();

      expect(await setSessionExpiry('missing', null)).toBe(false);
    });

    it('surfaces any other write failure', async () => {
      const update = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('denied'), { code: 7 }));
      (getAdminFirestore as Mock).mockReturnValue({
        collection: () => ({ doc: () => ({ update }) }),
      });
      _resetForTesting();

      await expect(setSessionExpiry('session-1', null)).rejects.toThrow(
        'denied',
      );
    });
  });

  describe('listSessionDocsWrittenSince', () => {
    it('reads by the writtenAt stamp, drops it from the doc, and returns the read time', async () => {
      const since = Timestamp.fromMillis(1_000);
      const readTime = Timestamp.fromMillis(2_000);
      const where = vi.fn().mockReturnValue({
        get: async () => ({
          docs: [
            {
              data: () => ({
                ...sessionDoc({ agent: 'claude-code' }),
                expireAt: Timestamp.fromDate(new Date('2027-01-01T00:00:00Z')),
                writtenAt: Timestamp.fromMillis(1_500),
              }),
            },
          ],
          readTime,
        }),
      });
      const firestore = { collection: () => ({ where }) };

      const result = await listSessionDocsWrittenSince(
        firestore as never,
        since,
      );

      expect(where).toHaveBeenCalledWith('writtenAt', '>=', since);
      expect(result.readTime).toBe(readTime);
      expect(result.docs).toHaveLength(1);
      expect(result.docs[0]).not.toHaveProperty('writtenAt');
      expect(result.docs[0]?.expireAt).toBe('2027-01-01T00:00:00.000Z');
    });
  });

  describe('backfillSessionSpend', () => {
    interface FakeDoc {
      id: string;
      data: Record<string, unknown>;
    }

    const USAGE = {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };

    function spendDoc(
      id: string,
      overrides: Record<string, unknown> = {},
    ): FakeDoc {
      return {
        id,
        data: {
          lastActivityAt: '2026-11-20T10:00:00.000Z',
          tokens: USAGE,
          model: 'claude-sonnet-4-5',
          totalCostUsd: 1.25,
          ...overrides,
        },
      };
    }

    function backfillFirestore(
      docs: FakeDoc[],
      current: Partial<
        Record<string, Record<string, unknown> | undefined>
      > = {},
    ) {
      const written: Array<{ id: string; fields: Record<string, unknown> }> =
        [];
      const queries: Array<Record<string, unknown>> = [];

      const pageFor = (remaining: FakeDoc[], size: number) => ({
        get: async () => {
          const page = remaining.slice(0, size);
          return {
            size: page.length,
            docs: page.map((doc) => ({
              id: doc.id,
              ref: { id: doc.id },
              data: () => doc.data,
            })),
          };
        },
      });

      const selectedFor = (
        remaining: FakeDoc[],
        query: Record<string, unknown>,
      ) => ({
        startAfter: (cursor: string) => {
          query['startAfter'] = cursor;
          return selectedFor(
            remaining.filter((doc) => doc.id > cursor),
            query,
          );
        },
        limit: (size: number) => {
          query['limit'] = size;
          return pageFor(remaining, size);
        },
      });

      const queryFor = (
        remaining: FakeDoc[],
        query: Record<string, unknown>,
      ) => ({
        orderBy: () => ({
          select: (...fields: string[]) => {
            query['selected'] = fields;
            return selectedFor(remaining, query);
          },
        }),
      });

      return {
        written,
        queries,
        firestore: {
          collection: () => {
            const query: Record<string, unknown> = {};
            queries.push(query);
            return queryFor(docs, query);
          },
          runTransaction: async (
            work: (transaction: {
              get: (ref: { id: string }) => Promise<{
                data: () => Record<string, unknown> | undefined;
              }>;
              update: (ref: { id: string }, fields: unknown) => void;
            }) => Promise<boolean>,
          ) =>
            work({
              get: async (ref) => ({
                data: () =>
                  ref.id in current
                    ? current[ref.id]
                    : docs.find((doc) => doc.id === ref.id)?.data,
              }),
              update: (ref, fields) => {
                written.push({ id: ref.id, fields });
              },
            }),
        },
      };
    }

    function useFakeFirestore(firestore: unknown) {
      (getAdminFirestore as Mock).mockReturnValue(firestore);
      _resetForTesting();
    }

    it('reports a stale doc without writing during a dry run', async () => {
      const fake = backfillFirestore([spendDoc('session-1')]);
      useFakeFirestore(fake.firestore);

      const page = await backfillSessionSpend({ apply: false });

      expect(page).toEqual({
        scanned: 1,
        stale: 1,
        written: 0,
        unusable: 0,
        scannedOutsideWindow: 0,
      });
      expect(fake.written).toEqual([]);
    });

    it('writes the derived spend and refreshes writtenAt for a stale doc', async () => {
      const fake = backfillFirestore([spendDoc('session-1')]);
      useFakeFirestore(fake.firestore);

      const page = await backfillSessionSpend({ apply: true });

      expect(page.written).toBe(1);
      expect(fake.written).toEqual([
        {
          id: 'session-1',
          fields: {
            spend: { tokens: 1_500, costUsd: 1.25 },
            writtenAt: FieldValue.serverTimestamp(),
          },
        },
      ]);
      // The page reads only the derivation inputs, not the whole doc.
      expect(fake.queries[0]?.['selected']).toEqual([
        'lastActivityAt',
        'tokens',
        'model',
        'resolvedModel',
        'totalCostUsd',
        'spend',
      ]);
    });

    it('writes nothing when the stored spend already matches', async () => {
      const fake = backfillFirestore([
        spendDoc('session-1', { spend: { tokens: 1_500, costUsd: 1.25 } }),
      ]);
      useFakeFirestore(fake.firestore);

      const page = await backfillSessionSpend({ apply: true });

      expect(page).toMatchObject({ scanned: 1, stale: 0, written: 0 });
      expect(fake.written).toEqual([]);
    });

    it('resumes from the cursor a full page reports', async () => {
      const docs = [spendDoc('a'), spendDoc('b'), spendDoc('c')];
      const fake = backfillFirestore(docs);
      useFakeFirestore(fake.firestore);

      const first = await backfillSessionSpend({ apply: false, pageSize: 2 });
      expect(first).toMatchObject({ scanned: 2, nextCursor: 'b' });

      await backfillSessionSpend({
        apply: false,
        pageSize: 2,
        cursor: first.nextCursor,
      });
      expect(fake.queries[1]?.['startAfter']).toBe('b');
    });

    it('reports no cursor once a page comes back short', async () => {
      const fake = backfillFirestore([spendDoc('a')]);
      useFakeFirestore(fake.firestore);

      const page = await backfillSessionSpend({ apply: false, pageSize: 2 });

      expect(page).not.toHaveProperty('nextCursor');
    });

    it('leaves a session outside the active window alone', async () => {
      const fake = backfillFirestore([
        spendDoc('old', { lastActivityAt: '2026-10-01T10:00:00.000Z' }),
        spendDoc('new'),
      ]);
      useFakeFirestore(fake.firestore);

      const page = await backfillSessionSpend({
        apply: true,
        activeSince: '2026-11-01T00:00:00.000Z',
      });

      expect(page).toMatchObject({
        scanned: 2,
        stale: 1,
        written: 1,
        scannedOutsideWindow: 1,
      });
      expect(fake.written.map((entry) => entry.id)).toEqual(['new']);
    });

    it('counts a doc with unreadable usage instead of writing zeros', async () => {
      const fake = backfillFirestore([
        spendDoc('session-1', { tokens: { inputTokens: 10 } }),
      ]);
      useFakeFirestore(fake.firestore);

      const page = await backfillSessionSpend({ apply: true });

      expect(page).toMatchObject({ scanned: 1, stale: 0, unusable: 1 });
      expect(fake.written).toEqual([]);
    });

    it('skips the write when a live writer already brought the doc up to date', async () => {
      const fake = backfillFirestore([spendDoc('session-1')], {
        'session-1': {
          lastActivityAt: '2026-11-20T11:00:00.000Z',
          tokens: USAGE,
          model: 'claude-sonnet-4-5',
          totalCostUsd: 9.5,
          spend: { tokens: 1_500, costUsd: 9.5 },
        },
      });
      useFakeFirestore(fake.firestore);

      const page = await backfillSessionSpend({ apply: true });

      expect(page).toMatchObject({ stale: 1, written: 0 });
      expect(fake.written).toEqual([]);
    });

    it('writes nothing when the doc is gone by the time of the transaction', async () => {
      const fake = backfillFirestore([spendDoc('session-1')], {
        'session-1': undefined,
      });
      useFakeFirestore(fake.firestore);

      const page = await backfillSessionSpend({ apply: true });

      expect(page).toMatchObject({ stale: 1, written: 0 });
      expect(fake.written).toEqual([]);
    });
  });
});
