import 'server-only';

import crypto from 'node:crypto';

import {
  type CredentialMutation,
  type CredentialOperation,
  type CredentialWriteReceipt,
} from '@agent-lcars/orchestrator';
import { type Bucket, Storage } from '@google-cloud/storage';

import { codexCentralAuthObject } from './deployment';

export const CODEX_AUTH_MAX_BYTES = 256 * 1024;
export const CODEX_GLOBAL_LEASE_OBJECT = '_leases/codex-subscription.json';

export type CodexAuthStoreErrorKind =
  'not-found' | 'conflict' | 'invalid' | 'unavailable';

export class CodexAuthStoreError extends Error {
  constructor(
    readonly kind: CodexAuthStoreErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface CodexAuthSnapshot {
  authBase64: string;
  generation: string;
  sha256: string;
  receipt?: CredentialWriteReceipt;
}

export interface CodexAuthLease {
  runId: string;
  repository: string;
  /**
   * Absolute expiry shared by QueueExecutor runs. A holder that cannot renew
   * this record is no longer allowed to keep the single-use refresh token.
   */
  expiresAt: string;
  generation: string;
  /** Absent only on historical/hosted lease records, which remain readable. */
  claimFingerprint?: string;
  operationId?: string;
}

export interface CodexLeaseWrite {
  runId: string;
  repository: string;
  expiresAt: string;
  claimFingerprint: string;
  operationId: string;
}
export type CodexOwnedLease = CodexAuthLease & { claimFingerprint: string };
export interface CodexAuthStore {
  read(): Promise<CodexAuthSnapshot>;
  readLease(): Promise<CodexAuthLease | undefined>;
  createLease(input: CodexLeaseWrite): Promise<CodexOwnedLease>;
  takeLease(
    input: CodexLeaseWrite & { expectedGeneration: string },
  ): Promise<CodexOwnedLease>;
  /** Retains an expired exact-generation record: deleting would reopen a
   * delayed ifGenerationMatch=0 creation after a recovery barrier. */
  releaseLease(lease: CodexOwnedLease, operationId: string): Promise<void>;
  replace(input: {
    expectedGeneration: string;
    authBase64: string;
    receipt: CredentialWriteReceipt;
  }): Promise<void>;
  /** Resolves/fences one journalled CAS before its Run can be reclaimed.
   * Indeterminate storage failures throw and retain the reservation. */
  fenceMutation(input: {
    runId: string;
    operation: CredentialOperation;
    mutation: CredentialMutation;
  }): Promise<{ receipt?: CredentialWriteReceipt }>;
}

function leaseBytes(input: {
  runId: string;
  repository: string;
  expiresAt: string;
  claimFingerprint?: string;
  operationId?: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      runId: input.runId,
      repository: input.repository,
      expiresAt: input.expiresAt,
      ...(input.claimFingerprint === undefined
        ? {}
        : { claimFingerprint: input.claimFingerprint }),
      ...(input.operationId === undefined
        ? {}
        : { operationId: input.operationId }),
    }),
  );
}
function receiptFromMetadata(
  metadata: Record<string, unknown> | undefined,
): CredentialWriteReceipt | undefined {
  if (metadata === undefined) return undefined;
  const {
    lcarsOperationId,
    lcarsClaimFingerprint,
    lcarsExpectedGeneration,
    lcarsSha256,
  } = metadata;
  if (
    typeof lcarsOperationId !== 'string' ||
    lcarsOperationId.length === 0 ||
    typeof lcarsClaimFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(lcarsClaimFingerprint) ||
    typeof lcarsExpectedGeneration !== 'string' ||
    !/^[0-9]+$/.test(lcarsExpectedGeneration) ||
    typeof lcarsSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(lcarsSha256)
  )
    return undefined;
  return {
    operationId: lcarsOperationId,
    claimFingerprint: lcarsClaimFingerprint,
    expectedGeneration: lcarsExpectedGeneration,
    sha256: lcarsSha256,
  };
}
function receiptMetadata(
  receipt: CredentialWriteReceipt | undefined,
): Record<string, string> {
  return receipt === undefined
    ? {}
    : {
        lcarsOperationId: receipt.operationId,
        lcarsClaimFingerprint: receipt.claimFingerprint,
        lcarsExpectedGeneration: receipt.expectedGeneration,
        lcarsSha256: receipt.sha256,
      };
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function decodedAuth(authBase64: string): Buffer {
  const bytes = Buffer.from(authBase64, 'base64');
  if (bytes.length === 0 || bytes.length > CODEX_AUTH_MAX_BYTES) {
    throw new CodexAuthStoreError('invalid', 'Codex auth payload is invalid');
  }
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('not an object');
    }
  } catch {
    throw new CodexAuthStoreError('invalid', 'Codex auth payload is invalid');
  }
  return bytes;
}

function storageCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? Number((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Centrally owned Codex subscription credential storage.
 *
 * A read first resolves the current generation, then downloads that exact
 * immutable generation. A replace is conditional on the generation returned
 * by that read. The run-token broker authorizes the target repository before
 * it calls this store; the target repository never selects an auth object.
 * The caller never receives bucket credentials or an object URL.
 */
export class GcsCodexAuthStore implements CodexAuthStore {
  constructor(private readonly bucket: Bucket) {}

  async read(): Promise<CodexAuthSnapshot> {
    const name = codexCentralAuthObject();
    try {
      const [metadata] = await this.bucket.file(name).getMetadata();
      const generation = metadata.generation;
      if (!generation) {
        throw new CodexAuthStoreError(
          'not-found',
          'Codex authentication is not seeded',
        );
      }
      const [bytes] = await this.bucket
        .file(name, { generation })
        .download({ validation: 'crc32c' });
      decodedAuth(bytes.toString('base64'));
      const receipt = receiptFromMetadata(metadata.metadata);
      return {
        authBase64: bytes.toString('base64'),
        generation: String(generation),
        sha256: sha256(bytes),
        ...(receipt === undefined ? {} : { receipt }),
      };
    } catch (error) {
      if (error instanceof CodexAuthStoreError) throw error;
      if (storageCode(error) === 404) {
        throw new CodexAuthStoreError(
          'not-found',
          'Codex authentication is not seeded',
        );
      }
      throw new CodexAuthStoreError(
        'unavailable',
        'Codex authentication storage is unavailable',
      );
    }
  }

  async readLease(): Promise<CodexAuthLease | undefined> {
    try {
      const [metadata] = await this.bucket
        .file(CODEX_GLOBAL_LEASE_OBJECT)
        .getMetadata();
      const generation = metadata.generation;
      if (!generation) {
        throw new CodexAuthStoreError(
          'invalid',
          'Codex subscription lease is invalid',
        );
      }
      const [bytes] = await this.bucket
        .file(CODEX_GLOBAL_LEASE_OBJECT, { generation })
        .download({ validation: 'crc32c' });
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('runId' in parsed) ||
        typeof parsed.runId !== 'string' ||
        parsed.runId === '' ||
        !('repository' in parsed) ||
        typeof parsed.repository !== 'string' ||
        parsed.repository === '' ||
        !('expiresAt' in parsed) ||
        typeof parsed.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(parsed.expiresAt)) ||
        ('claimFingerprint' in parsed &&
          (typeof parsed.claimFingerprint !== 'string' ||
            !/^[a-f0-9]{64}$/.test(parsed.claimFingerprint))) ||
        ('operationId' in parsed &&
          (typeof parsed.operationId !== 'string' ||
            parsed.operationId.length === 0 ||
            parsed.operationId.length > 128))
      ) {
        throw new CodexAuthStoreError(
          'invalid',
          'Codex subscription lease is invalid',
        );
      }
      return {
        runId: parsed.runId,
        repository: parsed.repository,
        expiresAt: parsed.expiresAt,
        generation: String(generation),
        ...('claimFingerprint' in parsed
          ? { claimFingerprint: parsed.claimFingerprint as string }
          : {}),
        ...('operationId' in parsed
          ? { operationId: parsed.operationId as string }
          : {}),
      };
    } catch (error) {
      if (error instanceof CodexAuthStoreError) throw error;
      if (storageCode(error) === 404) return undefined;
      throw new CodexAuthStoreError(
        'unavailable',
        'Codex subscription lease storage is unavailable',
      );
    }
  }

  async createLease(input: CodexLeaseWrite): Promise<CodexOwnedLease> {
    await this.saveLease(input, '0');
    return this.confirmLease(input);
  }
  async takeLease(
    input: CodexLeaseWrite & { expectedGeneration: string },
  ): Promise<CodexOwnedLease> {
    await this.saveLease(input, input.expectedGeneration);
    return this.confirmLease(input);
  }
  private async confirmLease(input: CodexLeaseWrite): Promise<CodexOwnedLease> {
    const lease = await this.readLease();
    if (
      lease?.runId !== input.runId ||
      lease.repository !== input.repository ||
      lease.claimFingerprint !== input.claimFingerprint ||
      lease.operationId !== input.operationId
    ) {
      throw new CodexAuthStoreError(
        'conflict',
        'Codex subscription lease changed concurrently',
      );
    }
    return lease as CodexOwnedLease;
  }

  async releaseLease(
    lease: CodexOwnedLease,
    operationId: string,
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(lease.claimFingerprint)) {
      throw new CodexAuthStoreError(
        'invalid',
        'Codex lease authority is missing',
      );
    }
    try {
      await this.saveLease(
        { ...lease, operationId, expiresAt: '1970-01-01T00:00:00.000Z' },
        lease.generation,
      );
    } catch (error) {
      // A replaced generation is a definitive no-op, preserving the old
      // cleanup semantics while never targeting the replacement snapshot.
      if (error instanceof CodexAuthStoreError && error.kind === 'conflict')
        return;
      throw error;
    }
  }

  private async saveLease(
    input: {
      runId: string;
      repository: string;
      expiresAt: string;
      claimFingerprint?: string;
      operationId?: string;
    },
    expectedGeneration: string,
  ): Promise<void> {
    try {
      await this.bucket
        .file(CODEX_GLOBAL_LEASE_OBJECT)
        .save(leaseBytes(input), {
          resumable: false,
          validation: 'crc32c',
          preconditionOpts: { ifGenerationMatch: expectedGeneration },
          metadata: { contentType: 'application/json' },
        });
    } catch (error) {
      if (storageCode(error) === 412) {
        throw new CodexAuthStoreError(
          'conflict',
          'Codex subscription lease changed concurrently',
        );
      }
      throw new CodexAuthStoreError(
        'unavailable',
        'Codex subscription lease storage is unavailable',
      );
    }
  }

  async replace(input: {
    expectedGeneration: string;
    authBase64: string;
    receipt: CredentialWriteReceipt;
  }): Promise<void> {
    if (!/^[1-9][0-9]*$/.test(input.expectedGeneration))
      throw new CodexAuthStoreError(
        'invalid',
        'A restored credential generation is required',
      );
    const bytes = decodedAuth(input.authBase64);
    if (
      input.receipt.expectedGeneration !== input.expectedGeneration ||
      input.receipt.sha256 !== sha256(bytes) ||
      !/^[a-f0-9]{64}$/.test(input.receipt.claimFingerprint)
    )
      throw new CodexAuthStoreError(
        'invalid',
        'Credential mutation receipt is invalid',
      );
    try {
      await this.bucket.file(codexCentralAuthObject()).save(bytes, {
        resumable: false,
        validation: 'crc32c',
        preconditionOpts: {
          ifGenerationMatch: input.expectedGeneration,
        },
        metadata: {
          contentType: 'application/json',
          metadata: receiptMetadata(input.receipt),
        },
      });
    } catch (error) {
      if (storageCode(error) === 412) {
        throw new CodexAuthStoreError(
          'conflict',
          'Codex authentication was already rotated',
        );
      }
      throw new CodexAuthStoreError(
        'unavailable',
        'Codex authentication storage is unavailable',
      );
    }
  }

  async fenceMutation(input: {
    runId: string;
    operation: CredentialOperation;
    mutation: CredentialMutation;
  }): Promise<{ receipt?: CredentialWriteReceipt }> {
    const { operation, mutation } = input;
    if (
      mutation.kind === 'auth-write' &&
      !/^[1-9][0-9]*$/.test(mutation.expectedGeneration)
    )
      throw new CodexAuthStoreError(
        'invalid',
        'A restored credential generation is required',
      );
    // A changed nonzero generation permanently rejects the delayed old CAS.
    // Creation uses0, so its barrier must remain as a retained lease object.
    // Canonical release therefore writes an expired record instead of deleting.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        if (mutation.kind === 'auth-write') {
          let current: CodexAuthSnapshot;
          try {
            current = await this.read();
          } catch (error) {
            if (
              error instanceof CodexAuthStoreError &&
              error.kind === 'not-found'
            )
              return {};
            throw error;
          }
          const receipt = current.receipt;
          if (current.generation !== mutation.expectedGeneration) {
            return receipt?.operationId === mutation.id &&
              receipt.claimFingerprint === operation.claimFingerprint &&
              receipt.expectedGeneration === mutation.expectedGeneration &&
              receipt.sha256 === mutation.sha256 &&
              current.sha256 === mutation.sha256
              ? { receipt }
              : {};
          }
          // Advance the generation with unchanged bytes, retaining any prior
          // receipt. This wins against a late original write or observes its win.
          await this.bucket
            .file(codexCentralAuthObject())
            .save(decodedAuth(current.authBase64), {
              resumable: false,
              validation: 'crc32c',
              preconditionOpts: {
                ifGenerationMatch: mutation.expectedGeneration,
              },
              metadata: {
                contentType: 'application/json',
                metadata: receiptMetadata(current.receipt),
              },
            });
          return {};
        }
        const lease = await this.readLease();
        if (lease === undefined) {
          if (mutation.expectedGeneration !== '0') return {};
          await this.saveLease(
            {
              runId: input.runId,
              repository:
                mutation.kind === 'lease-write'
                  ? mutation.repository
                  : 'recovery',
              expiresAt: '1970-01-01T00:00:00.000Z',
              claimFingerprint: operation.claimFingerprint,
              operationId: `fence:${mutation.id}`,
            },
            '0',
          );
          return {};
        }
        if (lease.generation !== mutation.expectedGeneration) return {};
        // Preserve the existing owner's bytes/expiry. No late CAS to this old
        // generation can then renew, take or release a successor's lease.
        const cleanup =
          mutation.kind === 'lease-write' &&
          mutation.expiresAt === '1970-01-01T00:00:00.000Z' &&
          lease.runId === input.runId &&
          lease.claimFingerprint === operation.claimFingerprint &&
          lease.repository === mutation.repository;
        await this.saveLease(
          {
            ...lease,
            ...(cleanup ? { expiresAt: mutation.expiresAt } : {}),
            operationId: `fence:${mutation.id}`,
          },
          lease.generation,
        );
        return {};
      } catch (error) {
        if (
          storageCode(error) === 412 ||
          (error instanceof CodexAuthStoreError && error.kind === 'conflict')
        )
          continue;
        if (error instanceof CodexAuthStoreError) throw error;
        throw new CodexAuthStoreError(
          'unavailable',
          'Credential operation remains unresolved',
        );
      }
    }
    throw new CodexAuthStoreError(
      'unavailable',
      'Credential operation remains unresolved',
    );
  }
}

export function codexAuthStore(bucketName: string): GcsCodexAuthStore {
  return new GcsCodexAuthStore(new Storage().bucket(bucketName));
}
