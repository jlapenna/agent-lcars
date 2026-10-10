import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CODEX_GLOBAL_LEASE_OBJECT,
  CodexAuthStoreError,
  GcsCodexAuthStore,
} from './codex-auth-store';
import { codexCentralAuthObject } from './deployment';
import { ConditionalCodexBucket, deferred } from './testing/codex-auth-bucket';

const fingerprint = 'a'.repeat(64);
const leaseInput = {
  runId: 'work:codex/r1',
  repository: 'jlapenna/agent-lcars',
  expiresAt: '2026-10-10T12:00:00.000Z',
  claimFingerprint: fingerprint,
  operationId: 'original:1',
};
function fixture() {
  const fake = new ConditionalCodexBucket();
  const original = fake.seed(
    codexCentralAuthObject(),
    Buffer.from('{"tokens":{"access":"original"}}'),
  );
  return { fake, original, store: new GcsCodexAuthStore(fake.bucket) };
}
function replacement(generation: string, operationId = 'original:1') {
  const bytes = Buffer.from('{"tokens":{"access":"rotated"}}');
  return {
    expectedGeneration: generation,
    authBase64: bytes.toString('base64'),
    receipt: {
      operationId,
      claimFingerprint: fingerprint,
      expectedGeneration: generation,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    },
  };
}
function operation() {
  return {
    id: 'original',
    kind: 'persist' as const,
    claimFingerprint: fingerprint,
    startedAt: '2026-10-10T10:00:00.000Z',
    recoverAfter: '2026-10-10T10:05:00.000Z',
    mutationSequence: 1,
  };
}

describe('GcsCodexAuthStore conditional generation boundary', () => {
  it('downloads the exact immutable generation whose metadata it observed', async () => {
    const { fake, original, store } = fixture();
    const realFile = fake.bucket.file.bind(fake.bucket);
    let changed = false;
    fake.bucket.file = ((name: string, options?: { generation?: string }) => {
      const file = realFile(name, options);
      if (options?.generation === undefined && !changed) {
        const getMetadata = file.getMetadata.bind(file);
        file.getMetadata = (async () => {
          const metadata = await getMetadata();
          changed = true;
          fake.seed(name, Buffer.from('{"tokens":{"access":"other"}}'));
          return metadata;
        }) as typeof file.getMetadata;
      }
      return file;
    }) as typeof fake.bucket.file;
    const snapshot = await store.read();
    expect(snapshot.generation).toBe(original.generation);
    expect(Buffer.from(snapshot.authBase64, 'base64')).toEqual(original.bytes);
  });

  it('conditionally rotates and records the exact original claim/action receipt', async () => {
    const { store, original } = fixture();
    const input = replacement(original.generation);
    await store.replace(input);
    expect(await store.read()).toMatchObject({
      authBase64: input.authBase64,
      receipt: input.receipt,
    });
    await expect(store.replace(input)).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('rejects absent-generation auth writes before any storage mutation', async () => {
    const { fake, store } = fixture();
    fake.objects.delete(codexCentralAuthObject());
    await expect(store.replace(replacement('0'))).rejects.toMatchObject({
      kind: 'invalid',
    });
    expect(fake.attempts).toHaveLength(0);
  });

  it('rejects a mismatched checksum receipt before external IO', async () => {
    const { fake, original, store } = fixture();
    const input = replacement(original.generation);
    input.receipt.sha256 = '0'.repeat(64);
    await expect(store.replace(input)).rejects.toMatchObject({
      kind: 'invalid',
    });
    expect(fake.attempts).toHaveLength(0);
  });

  it('reads historical lease bytes but uses original snapshot generations for owned writes', async () => {
    const { fake, store } = fixture();
    fake.seed(
      CODEX_GLOBAL_LEASE_OBJECT,
      Buffer.from(
        JSON.stringify({
          runId: 'historical',
          repository: 'octo/example',
          expiresAt: '2026-10-10T09:00:00.000Z',
        }),
      ),
    );
    const historical = await store.readLease();
    expect(historical?.claimFingerprint).toBeUndefined();
    const lease = await store.takeLease({
      ...leaseInput,
      expectedGeneration: historical!.generation,
    });
    expect(lease.claimFingerprint).toBe(fingerprint);
    const replacementLease = await store.takeLease({
      ...leaseInput,
      operationId: 'fresh:1',
      claimFingerprint: 'b'.repeat(64),
      expectedGeneration: lease.generation,
    });
    await expect(
      store.releaseLease(lease, 'old-cleanup:1'),
    ).resolves.toBeUndefined();
    expect(await store.readLease()).toEqual(replacementLease);
  });

  it('retains an expired tombstone and permits matching-generation healthy successor progress', async () => {
    const { store } = fixture();
    const lease = await store.createLease(leaseInput);
    await store.releaseLease(lease, 'cleanup:1');
    const retired = await store.readLease();
    expect(retired?.expiresAt).toBe('1970-01-01T00:00:00.000Z');
    expect(retired?.generation).not.toBe(lease.generation);
    const next = await store.takeLease({
      ...leaseInput,
      claimFingerprint: 'b'.repeat(64),
      operationId: 'next:1',
      expectedGeneration: retired!.generation,
    });
    expect(await store.readLease()).toEqual(next);
  });

  it('fences a delayed create0 through recovery and a successor take/release cycle', async () => {
    const { fake, store } = fixture();
    const entered = deferred(),
      delayed = deferred();
    fake.beforeSave = async (attempt) => {
      if (
        attempt.name === CODEX_GLOBAL_LEASE_OBJECT &&
        JSON.parse(attempt.bytes.toString()).operationId ===
          leaseInput.operationId
      ) {
        entered.resolve();
        await delayed.promise;
      }
    };
    const old = store.createLease(leaseInput);
    const observed = old.catch((error: unknown) => error);
    await entered.promise;
    const mutation = {
      kind: 'lease-write' as const,
      id: leaseInput.operationId,
      expectedGeneration: '0',
      repository: leaseInput.repository,
      expiresAt: leaseInput.expiresAt,
    };
    await store.fenceMutation({
      runId: leaseInput.runId,
      operation: operation(),
      mutation,
    });
    const barrier = await store.readLease();
    const next = await store.takeLease({
      ...leaseInput,
      claimFingerprint: 'b'.repeat(64),
      operationId: 'next:1',
      expectedGeneration: barrier!.generation,
    });
    await store.releaseLease(next, 'next:2');
    const successor = await store.readLease();
    delayed.resolve();
    expect(await observed).toBeInstanceOf(CodexAuthStoreError);
    expect(await observed).toMatchObject({ kind: 'conflict' });
    expect(await store.readLease()).toEqual(successor);
    expect(fake.commits).toHaveLength(3);
  });

  it('demonstrates why deleting a create0 barrier would admit the delayed old RPC', async () => {
    const { store, fake } = fixture();
    const entered = deferred(),
      delayed = deferred();
    fake.beforeSave = async (attempt) => {
      if (
        JSON.parse(attempt.bytes.toString()).operationId ===
        leaseInput.operationId
      ) {
        entered.resolve();
        await delayed.promise;
      }
    };
    const old = store.createLease(leaseInput);
    await entered.promise;
    await store.fenceMutation({
      runId: leaseInput.runId,
      operation: operation(),
      mutation: {
        kind: 'lease-write',
        id: leaseInput.operationId,
        expectedGeneration: '0',
        repository: leaseInput.repository,
        expiresAt: leaseInput.expiresAt,
      },
    });
    const barrier = await store.readLease();
    // Counterfactual legacy delete, entirely inside this isolated fake bucket.
    await fake.bucket
      .file(CODEX_GLOBAL_LEASE_OBJECT)
      .delete({ ifGenerationMatch: barrier!.generation });
    delayed.resolve();
    expect((await old).claimFingerprint).toBe(fingerprint);
  });

  it.each(['write-wins', 'fence-wins'] as const)(
    'recovers an auth rotation with actual CAS ordering: %s',
    async (ordering) => {
      const { fake, original, store } = fixture();
      const input = replacement(original.generation);
      const entered = deferred(),
        delayed = deferred();
      if (ordering === 'fence-wins') {
        fake.beforeSave = async (attempt) => {
          if (attempt.metadata.lcarsOperationId === input.receipt.operationId) {
            entered.resolve();
            await delayed.promise;
          }
        };
      } else {
        fake.afterSave = async (attempt) => {
          if (attempt.metadata.lcarsOperationId === input.receipt.operationId)
            throw Object.assign(new Error('lost response'), { code: 503 });
        };
      }
      const old = store.replace(input).catch((error: unknown) => error);
      const initial = ordering === 'write-wins' ? await old : undefined;
      if (ordering === 'fence-wins') await entered.promise;
      expect((initial as CodexAuthStoreError | undefined)?.kind).toBe(
        ordering === 'write-wins' ? 'unavailable' : undefined,
      );
      const resolved = await store.fenceMutation({
        runId: leaseInput.runId,
        operation: operation(),
        mutation: {
          kind: 'auth-write',
          id: input.receipt.operationId,
          expectedGeneration: input.expectedGeneration,
          sha256: input.receipt.sha256,
        },
      });
      expect(resolved).toEqual(
        ordering === 'write-wins' ? { receipt: input.receipt } : {},
      );
      let late: unknown;
      let preserved: boolean | undefined;
      if (ordering === 'fence-wins') {
        const newGeneration = (await store.read()).generation;
        await store.replace(replacement(newGeneration, 'next:1'));
        const successor = await store.read();
        delayed.resolve();
        late = await old;
        preserved =
          JSON.stringify(await store.read()) === JSON.stringify(successor);
      }
      expect((late as CodexAuthStoreError | undefined)?.kind).toBe(
        ordering === 'fence-wins' ? 'conflict' : undefined,
      );
      expect(preserved).toBe(ordering === 'fence-wins' ? true : undefined);
    },
  );

  it('keeps recovery unresolved when its barrier itself has an ambiguous storage failure', async () => {
    const { fake, original, store } = fixture();
    fake.beforeSave = async () => {
      throw Object.assign(new Error('unavailable'), { code: 503 });
    };
    const input = replacement(original.generation);
    await expect(
      store.fenceMutation({
        runId: leaseInput.runId,
        operation: operation(),
        mutation: {
          kind: 'auth-write',
          id: input.receipt.operationId,
          expectedGeneration: input.expectedGeneration,
          sha256: input.receipt.sha256,
        },
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fake.commits).toHaveLength(0);
  });
});
