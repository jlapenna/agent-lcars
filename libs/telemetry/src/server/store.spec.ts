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
  getAgentTelemetryWriterFirestore,
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
        expireAt: Timestamp.fromDate(new Date(doc.expireAt as string)),
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
      expect(Object.keys(fields)).toEqual(['expireAt']);
      expect(
        (fields['expireAt'] as FieldValue).isEqual(FieldValue.delete()),
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
});
