import { Timestamp } from '@google-cloud/firestore';
import { SessionDoc } from '@agent-lcars/telemetry';
import { FakeFirestore } from 'firestore-jest-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFirestoreStore } from './store';

let fakeFirestore: InstanceType<typeof FakeFirestore>;

vi.mock('@google-cloud/firestore', async () => ({
  ...(await vi.importActual('@google-cloud/firestore')),
  Firestore: vi.fn().mockImplementation(function FakeFirestoreCtor() {
    return fakeFirestore;
  }),
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

describe('createFirestoreStore', () => {
  beforeEach(() => {
    fakeFirestore = new FakeFirestore({}, { mutable: true });
  });

  it('writes expireAt as a native Firestore Timestamp, not the ISO string', async () => {
    const store = createFirestoreStore({ projectId: 'test-project' });

    await store.upsertSession(sessionDoc());

    const snap = await fakeFirestore
      .collection('sessions')
      .doc('session-1')
      .get();
    expect(snap.data()?.['expireAt']).toBeInstanceOf(Timestamp);
  });

  it('omits expireAt from the write when the doc has none', async () => {
    const doc = sessionDoc();
    delete (doc as Partial<SessionDoc>).expireAt;
    const store = createFirestoreStore({ projectId: 'test-project' });

    await store.upsertSession(doc);

    const snap = await fakeFirestore
      .collection('sessions')
      .doc('session-1')
      .get();
    expect(snap.data()).not.toHaveProperty('expireAt');
  });
});
