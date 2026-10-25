import {
  buildSessionDoc,
  codexAdapter,
  sessionWriteForEvent,
} from '@agent-lcars/telemetry';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  deletes: Symbol('delete'),
}));
vi.mock('@google-cloud/firestore', () => ({
  FieldValue: { delete: () => state.deletes },
  Firestore: class {
    collection() {
      return {
        doc: (id: string) => ({
          id,
          get: async () => ({
            exists: true,
            data: () => structuredClone(state.data),
          }),
        }),
      };
    }
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({
        get: async (ref: unknown) => ({
          ref,
          data: () => structuredClone(state.data),
        }),
        update: (_ref: unknown, fields: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(fields)) {
            if (value === state.deletes) delete state.data[key];
            else state.data[key] = value;
          }
        },
      });
    }
  },
}));
vi.mock('@google-cloud/storage', () => ({ Storage: class {} }));

import { defaultCliArchiveDependencies } from './cli-archive-command';

const summary = codexAdapter.reduce([
  JSON.stringify({
    timestamp: '2026-10-25T00:00:00Z',
    type: 'session_meta',
    payload: { id: 'session-1', cwd: '/work', source: 'cli' },
  }),
])[0];
const now = '2026-10-25T00:00:00Z';
const deps = () =>
  defaultCliArchiveDependencies({
    AGENT_TELEMETRY_HOST: 'host',
    LCARS_TELEMETRY_REPOS: 'owner/repo',
    AGENT_TELEMETRY_WRITER_KEY_JSON: JSON.stringify({
      client_email: 'fixture@example.invalid',
      private_key: 'fixture-only',
      project_id: 'fixture',
    }),
  });
beforeEach(() => {
  state.data = {
    ...buildSessionDoc(
      { ...summary, host: 'host', repo: { owner: 'owner', name: 'repo' } },
      'idle',
    ),
    source: 'cli',
  };
});
it('preserves the capture fence through a real hook reduction and rejects publication after revocation', async () => {
  const store = deps();
  const session = (await store.getSession('session-1'))!;
  await store.claim(session, 'capture-1');
  const event = {
    version: 1 as const,
    eventId: 'event-1',
    seq: 1,
    occurredAt: now,
    host: 'host',
    agent: 'codex' as const,
    sessionId: 'session-1',
    kind: 'stop' as const,
    runtime: { name: 'codex' as const },
    summary: { ...summary, repo: { owner: 'owner', name: 'repo' } },
  };
  const write = sessionWriteForEvent(
    event,
    state.data as unknown as Parameters<typeof sessionWriteForEvent>[1],
    now,
  );
  if (write?.doc.source !== 'cli') throw new Error('Expected CLI hook write');
  expect(write.doc.cliTranscriptArchive).toEqual({
    status: 'pending',
    captureId: 'capture-1',
  });
  Object.assign(state.data, write?.doc);
  await store.revoke(session);
  expect(
    await store.publish(
      session,
      'capture-1',
      'gs://fixture/object',
      '2026-11-01T00:00:00Z',
    ),
  ).toBe(false);
  expect(state.data['cliTranscriptArchive']).toEqual({ status: 'expired' });
  expect(state.data['transcriptGcsUri']).toBeUndefined();
});
it('does not turn an ambiguously acknowledged successful publication into failed', async () => {
  const store = deps();
  const session = (await store.getSession('session-1'))!;
  await store.claim(session, 'capture-1');
  expect(
    await store.publish(
      session,
      'capture-1',
      'gs://fixture/object',
      '2026-11-01T00:00:00Z',
    ),
  ).toBe(true);
  await store.fail(session, 'capture-1');
  expect(state.data['cliTranscriptArchive']).toMatchObject({
    status: 'available',
  });
  expect(state.data['transcriptGcsUri']).toBe('gs://fixture/object');
});
it('refuses an older capture after a newer consent and fences a changed host', async () => {
  const store = deps();
  const session = (await store.getSession('session-1'))!;
  await store.claim(session, 'capture-1');
  await store.claim(session, 'capture-2');
  expect(
    await store.publish(
      session,
      'capture-1',
      'gs://fixture/object',
      '2026-11-01T00:00:00Z',
    ),
  ).toBe(false);
  state.data['host'] = 'another-host';
  expect(
    await store.publish(
      session,
      'capture-2',
      'gs://fixture/object',
      '2026-11-01T00:00:00Z',
    ),
  ).toBe(false);
});
