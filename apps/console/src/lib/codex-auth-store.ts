import 'server-only';

import crypto from 'node:crypto';

import { type Bucket, Storage } from '@google-cloud/storage';

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
}

export interface CodexAuthLease {
  runId: string;
  repository: string;
  /**
   * Absolute expiry shared with the hosted lane. A holder that cannot renew
   * this record is no longer allowed to keep the single-use refresh token.
   */
  expiresAt: string;
  generation: string;
}

export interface CodexAuthStore {
  read(repository: string): Promise<CodexAuthSnapshot>;
  readLease(): Promise<CodexAuthLease | undefined>;
  createLease(input: {
    runId: string;
    repository: string;
    expiresAt: string;
  }): Promise<void>;
  takeLease(input: {
    runId: string;
    repository: string;
    expiresAt: string;
    expectedGeneration: string;
  }): Promise<void>;
  releaseLease(runId: string): Promise<void>;
  replace(input: {
    repository: string;
    expectedGeneration: string;
    authBase64: string;
  }): Promise<void>;
}

function leaseBytes(input: {
  runId: string;
  repository: string;
  expiresAt: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      runId: input.runId,
      repository: input.repository,
      expiresAt: input.expiresAt,
    }),
  );
}

function objectName(repository: string): string {
  return `${repository}/auth.json`;
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
 * Repository-scoped Codex subscription credential storage.
 *
 * A read first resolves the current generation, then downloads that exact
 * immutable generation. A replace is conditional on the generation returned
 * by that read, preserving the same one-lineage CAS contract as the hosted
 * Codex lane. The caller never receives bucket credentials or an object URL.
 */
export class GcsCodexAuthStore implements CodexAuthStore {
  constructor(private readonly bucket: Bucket) {}

  async read(repository: string): Promise<CodexAuthSnapshot> {
    const name = objectName(repository);
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
      return {
        authBase64: bytes.toString('base64'),
        generation: String(generation),
        sha256: sha256(bytes),
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
        !Number.isFinite(Date.parse(parsed.expiresAt))
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

  async createLease(input: {
    runId: string;
    repository: string;
    expiresAt: string;
  }): Promise<void> {
    await this.saveLease(input, '0');
  }

  async takeLease(input: {
    runId: string;
    repository: string;
    expiresAt: string;
    expectedGeneration: string;
  }): Promise<void> {
    await this.saveLease(input, input.expectedGeneration);
  }

  async releaseLease(runId: string): Promise<void> {
    const lease = await this.readLease();
    if (lease === undefined || lease.runId !== runId) return;
    try {
      await this.bucket.file(CODEX_GLOBAL_LEASE_OBJECT).delete({
        ifGenerationMatch: lease.generation,
      });
    } catch (error) {
      if (storageCode(error) === 404 || storageCode(error) === 412) return;
      throw new CodexAuthStoreError(
        'unavailable',
        'Codex subscription lease storage is unavailable',
      );
    }
  }

  private async saveLease(
    input: { runId: string; repository: string; expiresAt: string },
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
    repository: string;
    expectedGeneration: string;
    authBase64: string;
  }): Promise<void> {
    const bytes = decodedAuth(input.authBase64);
    try {
      await this.bucket.file(objectName(input.repository)).save(bytes, {
        resumable: false,
        validation: 'crc32c',
        preconditionOpts: {
          ifGenerationMatch: input.expectedGeneration,
        },
        metadata: { contentType: 'application/json' },
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
}

export function codexAuthStore(bucketName: string): GcsCodexAuthStore {
  return new GcsCodexAuthStore(new Storage().bucket(bucketName));
}
