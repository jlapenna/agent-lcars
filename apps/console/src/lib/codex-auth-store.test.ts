import type { Bucket } from '@google-cloud/storage';
import { describe, expect, it, vi } from 'vitest';

import { CodexAuthStoreError, GcsCodexAuthStore } from './codex-auth-store';

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

    const snapshot = await store.read('jlapenna/agent-lcars');

    expect(file).toHaveBeenNthCalledWith(1, 'jlapenna/agent-lcars/auth.json');
    expect(file).toHaveBeenNthCalledWith(2, 'jlapenna/agent-lcars/auth.json', {
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
      repository: 'jlapenna/agent-lcars',
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
        repository: 'jlapenna/agent-lcars',
        expectedGeneration: '7',
        authBase64: Buffer.from('{"tokens":{}}').toString('base64'),
      }),
    ).rejects.toMatchObject<CodexAuthStoreError>({ kind: 'conflict' });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
