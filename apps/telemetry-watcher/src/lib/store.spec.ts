import { SessionDoc, SessionWrite } from '@agent-lcars/telemetry';
import { FieldValue, Timestamp } from '@google-cloud/firestore';
import { FakeFirestore } from 'firestore-jest-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFirestoreStore,
  createSessionSchemaMigrationStore,
  MAX_SESSION_SCHEMA_MIGRATION_PAGE_SIZE,
} from './store';

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

describe('createSessionSchemaMigrationStore', () => {
  beforeEach(() => {
    fakeFirestore = new FakeFirestore(
      {
        sessions: [
          { id: 'session-1', sessionId: 'session-1', source: 'cli' },
          { id: 'session-2', sessionId: 'session-2', source: 'cli' },
        ],
      },
      { mutable: true },
    );
  });

  it('returns a bounded page and proves when a continuation is required', async () => {
    const store = createSessionSchemaMigrationStore({
      projectId: 'test-project',
    });

    const page = await store.inventory({ limit: 1 });

    expect(page.records).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('session-1');
    await expect(
      store.inventory({ limit: MAX_SESSION_SCHEMA_MIGRATION_PAGE_SIZE + 1 }),
    ).rejects.toThrow('page size');
  });

  it('re-reads and patches an explicit backfill in one transaction', async () => {
    const store = createSessionSchemaMigrationStore({
      projectId: 'test-project',
    });

    await expect(
      store.applySchemaBackfill({
        sessionId: 'session-1',
        agent: 'codex',
        repo: { owner: 'jlapenna', name: 'agent-lcars' },
      }),
    ).resolves.toEqual({ changed: true });

    const snapshot = await fakeFirestore
      .collection('sessions')
      .doc('session-1')
      .get();
    expect(snapshot.data()).toMatchObject({
      agent: 'codex',
      repo: { owner: 'jlapenna', name: 'agent-lcars' },
    });
  });

  it('rejects a conflicting current value without overwriting it', async () => {
    const store = createSessionSchemaMigrationStore({
      projectId: 'test-project',
    });
    await fakeFirestore
      .collection('sessions')
      .doc('session-1')
      .set({ agent: 'claude-code' }, { merge: true });

    await expect(
      store.applySchemaBackfill({
        sessionId: 'session-1',
        agent: 'codex',
        repo: { owner: 'jlapenna', name: 'agent-lcars' },
      }),
    ).rejects.toThrow('conflicting agent');

    const snapshot = await fakeFirestore
      .collection('sessions')
      .doc('session-1')
      .get();
    expect(snapshot.data()?.['agent']).toBe('claude-code');
  });
});
