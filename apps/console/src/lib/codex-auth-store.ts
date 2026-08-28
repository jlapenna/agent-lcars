import 'server-only';

import crypto from 'node:crypto';

import { type Bucket, Storage } from '@google-cloud/storage';

export const CODEX_AUTH_MAX_BYTES = 256 * 1024;

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

export interface CodexAuthStore {
  read(repository: string): Promise<CodexAuthSnapshot>;
  replace(input: {
    repository: string;
    expectedGeneration: string;
    authBase64: string;
  }): Promise<void>;
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
