import { Timestamp } from '@google-cloud/firestore';
import { getApps, initializeApp } from 'firebase-admin/app';
import {
  Firestore,
  getFirestore as getAdminFirestore,
} from 'firebase-admin/firestore';
import { FakeFirestore } from 'firestore-jest-mock';

import { SessionDoc } from '../lib/types';
import { describe, it, test, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  _resetForTesting,
  getAgentTelemetryWriterFirestore,
  upsertSession,
} from './store';

vi.mock('firebase-admin/app', () => ({
  getApps: vi.fn().mockReturnValue([]),
  initializeApp: vi.fn().mockReturnValue({}),
}));

vi.mock('firebase-admin/firestore', async () => ({
  getFirestore: vi.fn(),
  Timestamp: (await vi.importActual('@google-cloud/firestore')).Timestamp,
}));

vi.mock('@repo/util-server', async () => ({
  ...(await vi.importActual('@repo/util-server')),
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
    it('scopes the client to the dedicated agent-telemetry database', () => {
      getAgentTelemetryWriterFirestore();

      expect(getAdminFirestore).toHaveBeenCalledWith(
        expect.anything(),
        'agent-telemetry',
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

      await upsertSession(doc);

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
      await upsertSession(sessionDoc());

      const snap = await fakeFirestore
        .collection('sessions')
        .doc('session-1')
        .get();
      expect(snap.data()?.['expireAt']).toBeInstanceOf(Timestamp);
    });

    it('merges rather than overwrites on repeated upserts', async () => {
      await upsertSession(sessionDoc({ turns: 1 }));
      await upsertSession(sessionDoc({ turns: 2 }));

      const snap = await fakeFirestore
        .collection('sessions')
        .doc('session-1')
        .get();
      expect(snap.data()?.['turns']).toBe(2);
    });
  });
});
