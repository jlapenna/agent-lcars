import type { Bucket } from '@google-cloud/storage';
import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_CENTRAL_AUTH_OBJECT,
  CODEX_GLOBAL_LEASE_OBJECT,
  CodexAuthStoreError,
  GcsCodexAuthStore,
} from './codex-auth-store';

describe('GcsCodexAuthStore', () => {
  it('downloads the exact generation whose metadata it observed', async () => {
    const bytes = Buffer.from('{"tokens":{"access":"x"}}');
    const getMetadata = vi.fn(async () => [{ generation: '1700000000000001' }]);
    const download = vi.fn(async () => [bytes]);
    const file = vi.fn((name: string, options?: { generation?: string }) => ({
      getMetadata,
      download,
      save: vi.fn(),
      name,
      options,
    }));
    const store = new GcsCodexAuthStore({ file } as unknown as Bucket);

    const snapshot = await store.read();

    expect(file).toHaveBeenNthCalledWith(1, CODEX_CENTRAL_AUTH_OBJECT);
    expect(file).toHaveBeenNthCalledWith(2, CODEX_CENTRAL_AUTH_OBJECT, {
      generation: '1700000000000001',
    });
    expect(download).toHaveBeenCalledWith({ validation: 'crc32c' });
    expect(snapshot.generation).toBe('1700000000000001');
    expect(Buffer.from(snapshot.authBase64, 'base64')).toEqual(bytes);
    expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('replaces only when the restored GCS generation still matches', async () => {
    const save = vi.fn(async () => undefined);
    const file = vi.fn(() => ({ save }));
    const store = new GcsCodexAuthStore({ file } as unknown as Bucket);
    const bytes = Buffer.from('{"tokens":{"access":"rotated"}}');

    await store.replace({
      expectedGeneration: '1700000000000001',
      authBase64: bytes.toString('base64'),
    });

    expect(save).toHaveBeenCalledWith(bytes, {
      resumable: false,
      validation: 'crc32c',
      preconditionOpts: { ifGenerationMatch: '1700000000000001' },
      metadata: { contentType: 'application/json' },
    });
  });

  it('turns a failed generation precondition into a terminal conflict', async () => {
    const save = vi.fn(async () => {
      throw Object.assign(new Error('precondition'), { code: 412 });
    });
    const store = new GcsCodexAuthStore({
      file: vi.fn(() => ({ save })),
    } as unknown as Bucket);

    await expect(
      store.replace({
        expectedGeneration: '7',
        authBase64: Buffer.from('{"tokens":{}}').toString('base64'),
      }),
    ).rejects.toMatchObject<CodexAuthStoreError>({ kind: 'conflict' });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('reads the global subscription lease from the exact observed generation', async () => {
    const getMetadata = vi.fn(async () => [{ generation: '41' }]);
    const download = vi.fn(async () => [
      Buffer.from(
        JSON.stringify({
          runId: 'work:01CODEXLEASE0000000000000/r1',
          repository: 'jlapenna/agent-lcars',
          expiresAt: '2026-08-28T12:00:00.000Z',
        }),
      ),
    ]);
    const file = vi.fn(() => ({ getMetadata, download }));
    const store = new GcsCodexAuthStore({ file } as unknown as Bucket);

    await expect(store.readLease()).resolves.toEqual({
      runId: 'work:01CODEXLEASE0000000000000/r1',
      repository: 'jlapenna/agent-lcars',
      expiresAt: '2026-08-28T12:00:00.000Z',
      generation: '41',
    });
    expect(file).toHaveBeenNthCalledWith(1, CODEX_GLOBAL_LEASE_OBJECT);
    expect(file).toHaveBeenNthCalledWith(2, CODEX_GLOBAL_LEASE_OBJECT, {
      generation: '41',
    });
  });

  it('creates, takes, and releases the global lease with generation preconditions', async () => {
    const save = vi.fn(async () => undefined);
    const deleteFile = vi.fn(async () => undefined);
    const getMetadata = vi.fn(async () => [{ generation: '42' }]);
    const download = vi.fn(async () => [
      Buffer.from(
        JSON.stringify({
          runId: 'work:01CODEXLEASE0000000000000/r1',
          repository: 'jlapenna/agent-lcars',
          expiresAt: '2026-08-28T12:00:00.000Z',
        }),
      ),
    ]);
    const file = vi.fn(() => ({
      save,
      delete: deleteFile,
      getMetadata,
      download,
    }));
    const store = new GcsCodexAuthStore({ file } as unknown as Bucket);
    const input = {
      runId: 'work:01CODEXLEASE0000000000000/r1',
      repository: 'jlapenna/agent-lcars',
      expiresAt: '2026-08-28T12:00:00.000Z',
    };

    await store.createLease(input);
    await store.takeLease({ ...input, expectedGeneration: '41' });
    await store.releaseLease(input.runId);

    expect(save).toHaveBeenNthCalledWith(
      1,
      Buffer.from(JSON.stringify(input)),
      expect.objectContaining({
        preconditionOpts: { ifGenerationMatch: '0' },
      }),
    );
    expect(save).toHaveBeenNthCalledWith(
      2,
      Buffer.from(JSON.stringify(input)),
      expect.objectContaining({
        preconditionOpts: { ifGenerationMatch: '41' },
      }),
    );
    expect(deleteFile).toHaveBeenCalledWith({
      ifGenerationMatch: '42',
    });
  });
});
