import { PassThrough, Readable } from 'node:stream';

import {
  buildSessionDoc,
  codexAdapter,
  sessionWriteForEvent,
} from '@agent-lcars/telemetry';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  deletes: Symbol('delete'),
  metadata: {
    lifecycle: {
      rule: [
        {
          action: { type: 'Delete' },
          condition: { age: 7, matchesPrefix: ['cli-consented-v1/'] },
        },
      ],
    },
  } as unknown,
  lastWriteOptions: undefined as Record<string, unknown> | undefined,
  uploadedChunks: [] as Buffer[],
}));
vi.mock('@google-cloud/firestore', () => ({
  FieldValue: {
    delete: () => state.deletes,
    serverTimestamp: () => 'server-time',
  },
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
vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket() {
      return {
        getMetadata: async () => [state.metadata],
        file: () => ({
          createWriteStream: (options: Record<string, unknown>) => {
            state.lastWriteOptions = options;
            const sink = new PassThrough();
            sink.on('data', (chunk: Buffer) => {
              state.uploadedChunks.push(Buffer.from(chunk));
            });
            return sink;
          },
          delete: async () => undefined,
        }),
      };
    }
  },
}));

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
  state.uploadedChunks = [];
  state.lastWriteOptions = undefined;
  state.metadata = {
    lifecycle: {
      rule: [
        {
          action: { type: 'Delete' },
          condition: { age: 7, matchesPrefix: ['cli-consented-v1/'] },
        },
      ],
    },
  };
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
it('streams uploads via createWriteStream with bounded-chunk resumable uploads above 5 MiB and destroys stream on missing retention', async () => {
  const store = deps();
  await store.upload(
    'cli-consented-v1/codex/session-1/small.jsonl',
    Readable.from([Buffer.from('{"a":1}\n')]),
    8,
  );
  expect(state.lastWriteOptions).toEqual({
    resumable: false,
    contentType: 'application/x-ndjson',
    preconditionOpts: { ifGenerationMatch: 0 },
  });
  expect(Buffer.concat(state.uploadedChunks).toString('utf8')).toBe(
    '{"a":1}\n',
  );

  state.uploadedChunks = [];
  await store.upload(
    'cli-consented-v1/codex/session-1/large.jsonl',
    Readable.from([Buffer.from('{"big":true}\n')]),
    6 * 1024 * 1024,
  );
  expect(state.lastWriteOptions).toEqual({
    resumable: true,
    chunkSize: 8 * 1024 * 1024,
    contentType: 'application/x-ndjson',
    preconditionOpts: { ifGenerationMatch: 0 },
  });

  state.metadata = {};
  const rejectedSource = Readable.from([Buffer.from('{"blocked":1}\n')]);
  await expect(
    store.upload(
      'cli-consented-v1/codex/session-1/no.jsonl',
      rejectedSource,
      14,
    ),
  ).rejects.toThrow('retention-not-ready');
  expect(rejectedSource.destroyed).toBe(true);
});
