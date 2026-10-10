import type { Bucket } from '@google-cloud/storage';

interface StoredObject {
  generation: string;
  bytes: Buffer;
  metadata: Record<string, string>;
}
export interface SaveAttempt {
  name: string;
  bytes: Buffer;
  expectedGeneration: string;
  metadata: Record<string, string>;
}

/** Isolated conditional GCS boundary. Preconditions are evaluated at commit,
 * after any controlled RPC delay, so stale argument-only mocks cannot pass. */
export class ConditionalCodexBucket {
  private nextGeneration = 0;
  readonly objects = new Map<string, StoredObject>();
  private readonly versions = new Map<string, StoredObject>();
  readonly commits: SaveAttempt[] = [];
  readonly attempts: SaveAttempt[] = [];
  beforeSave?: (attempt: SaveAttempt) => Promise<void>;
  afterSave?: (attempt: SaveAttempt) => Promise<void>;
  /** Lost client response with a server-side RPC still able to commit later. */
  delayAndLoseResponse?: (attempt: SaveAttempt) => Promise<void> | undefined;
  readonly delayedResults: Promise<unknown>[] = [];

  seed(
    name: string,
    bytes: Buffer,
    metadata: Record<string, string> = {},
  ): StoredObject {
    const value = {
      generation: String(++this.nextGeneration),
      bytes: Buffer.from(bytes),
      metadata: { ...metadata },
    };
    this.objects.set(name, value);
    this.versions.set(`${name}:${value.generation}`, value);
    return value;
  }

  private missing(): never {
    throw Object.assign(new Error('not found'), { code: 404 });
  }
  private conflict(): never {
    throw Object.assign(new Error('precondition'), { code: 412 });
  }

  readonly bucket = {
    file: (name: string, options?: { generation?: string }) => ({
      getMetadata: async () => {
        const current = this.objects.get(name) ?? this.missing();
        return [
          { generation: current.generation, metadata: { ...current.metadata } },
        ];
      },
      download: async () => {
        const current =
          options?.generation === undefined
            ? this.objects.get(name)
            : this.versions.get(`${name}:${options.generation}`);
        if (current === undefined) this.missing();
        return [Buffer.from(current.bytes)];
      },
      save: async (
        bytes: Buffer,
        input: {
          preconditionOpts: { ifGenerationMatch: string };
          metadata?: { metadata?: Record<string, string> };
        },
      ) => {
        const attempt = {
          name,
          bytes: Buffer.from(bytes),
          expectedGeneration: String(input.preconditionOpts.ifGenerationMatch),
          metadata: { ...input.metadata?.metadata },
        };
        this.attempts.push(attempt);
        const commit = () => {
          const current = this.objects.get(name);
          if (
            attempt.expectedGeneration === '0'
              ? current !== undefined
              : current?.generation !== attempt.expectedGeneration
          )
            this.conflict();
          this.seed(name, bytes, attempt.metadata);
          this.commits.push(attempt);
        };
        const lost = this.delayAndLoseResponse?.(attempt);
        if (lost !== undefined) {
          this.delayedResults.push(
            lost.then(commit).catch((error: unknown) => error),
          );
          throw Object.assign(new Error('lost response'), { code: 503 });
        }
        await this.beforeSave?.(attempt);
        const current = this.objects.get(name);
        if (
          attempt.expectedGeneration === '0'
            ? current !== undefined
            : current?.generation !== attempt.expectedGeneration
        )
          this.conflict();
        this.seed(name, bytes, attempt.metadata);
        this.commits.push(attempt);
        await this.afterSave?.(attempt);
      },
      // Used only to demonstrate the retired deletion ABA in a negative fixture.
      delete: async (input: { ifGenerationMatch: string }) => {
        const current = this.objects.get(name) ?? this.missing();
        if (current.generation !== String(input.ifGenerationMatch))
          this.conflict();
        this.objects.delete(name);
      },
    }),
  } as unknown as Bucket;
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
