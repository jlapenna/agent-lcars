import { getApps, initializeApp } from 'firebase-admin/app';
import {
  Firestore,
  getFirestore as getAdminFirestore,
} from 'firebase-admin/firestore';
import { FakeFirestore } from 'firestore-jest-mock';

import { SessionDoc } from '../lib/types';
import {
  _resetForTesting,
  getAgentTelemetryFirestore,
  upsertSession,
} from './store';

jest.mock('firebase-admin/app', () => ({
  getApps: jest.fn().mockReturnValue([]),
  initializeApp: jest.fn().mockReturnValue({}),
}));

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(),
}));

jest.mock('@repo/util-server', () => ({
  ...jest.requireActual('@repo/util-server'),
  isEmulator: jest.fn().mockReturnValue(false),
  getProjectId: jest.fn().mockReturnValue('test-project'),
  getFirestoreEmulatorHost: jest.fn().mockReturnValue(undefined),
}));

function sessionDoc(overrides: Partial<SessionDoc> = {}): SessionDoc {
  return {
    sessionId: 'session-1',
    source: 'cli',
    liveness: 'live',
    startedAt: '2026-07-10T10:00:00.000Z',
    lastActivityAt: '2026-07-10T10:05:00.000Z',
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
    jest.clearAllMocks();
    _resetForTesting();
    fakeFirestore = new FakeFirestore(
      {},
      { mutable: true },
    ) as unknown as Firestore;
    (getApps as jest.Mock).mockReturnValue([]);
    (initializeApp as jest.Mock).mockReturnValue({});
    (getAdminFirestore as jest.Mock).mockReturnValue(fakeFirestore);
  });

  describe('getAgentTelemetryFirestore', () => {
    it('scopes the client to the dedicated agent-telemetry database', () => {
      getAgentTelemetryFirestore();

      expect(getAdminFirestore).toHaveBeenCalledWith(
        expect.anything(),
        'agent-telemetry',
      );
    });

    it('caches the client across calls instead of re-initializing', () => {
      const a = getAgentTelemetryFirestore();
      const b = getAgentTelemetryFirestore();

      expect(a).toBe(b);
      expect(getAdminFirestore).toHaveBeenCalledTimes(1);
      expect(initializeApp).toHaveBeenCalledTimes(1);
    });

    it('reuses an already-initialized app rather than creating a new one', () => {
      (getApps as jest.Mock).mockReturnValue([{ name: '[DEFAULT]' }]);

      getAgentTelemetryFirestore();

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
      expect(snap.data()).toEqual(doc);
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
