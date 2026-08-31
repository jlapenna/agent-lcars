import { SessionDoc, SessionWrite } from '@agent-lcars/telemetry';
import { FieldValue, Timestamp } from '@google-cloud/firestore';
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

function sessionWrite(
  overrides: Partial<SessionDoc> = {},
  clearFields: SessionWrite['clearFields'] = [],
): SessionWrite {
  return { doc: sessionDoc(overrides), clearFields };
}

describe('createFirestoreStore', () => {
  beforeEach(() => {
    fakeFirestore = new FakeFirestore({}, { mutable: true });
  });

  it('writes expireAt as a native Firestore Timestamp, not the ISO string', async () => {
    const store = createFirestoreStore({ projectId: 'test-project' });

    await store.upsertSession(sessionWrite());

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

    await store.upsertSession({ doc, clearFields: [] });

    const snap = await fakeFirestore
      .collection('sessions')
      .doc('session-1')
      .get();
    expect(snap.data()).not.toHaveProperty('expireAt');
  });

  it('maps clearFields to FieldValue.delete() sentinels in the write', async () => {
    const store = createFirestoreStore({ projectId: 'test-project' });

    await store.upsertSession(sessionWrite({}, ['status', 'statusUpdatedAt']));

    const snap = await fakeFirestore
      .collection('sessions')
      .doc('session-1')
      .get();
    // FieldValue.delete() is a singleton sentinel (same instance every
    // call) in the real @google-cloud/firestore SDK, so reference equality
    // is the correct, exact assertion here — the FakeFirestore double
    // records whatever was passed to `.set()` without interpreting the
    // sentinel (it doesn't actually delete fields), which is exactly the
    // boundary this store module owns: translating clearFields into the
    // right sentinel, not simulating Firestore's own delete semantics.
    expect(snap.data()?.['status']).toBe(FieldValue.delete());
    expect(snap.data()?.['statusUpdatedAt']).toBe(FieldValue.delete());
  });

  it('requests no field deletions when clearFields is empty', async () => {
    const store = createFirestoreStore({ projectId: 'test-project' });

    await store.upsertSession(sessionWrite());

    const snap = await fakeFirestore
      .collection('sessions')
      .doc('session-1')
      .get();
    expect(snap.data()).not.toHaveProperty('status');
    expect(snap.data()).not.toHaveProperty('statusUpdatedAt');
  });
});
