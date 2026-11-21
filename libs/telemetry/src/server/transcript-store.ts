import { assertNotBrowser } from '@agent-lcars/util';
import { getProjectId } from '@agent-lcars/util-server';
import { Storage } from '@google-cloud/storage';

assertNotBrowser();

/** Default byte window (512 KiB) read per paginated JSONL transcript request. */
export const DEFAULT_TRANSCRIPT_PAGE_BYTES = 512 * 1024;

/** Maximum bytes buffered to complete a single JSONL line (16 MiB) before
 * scanning past that oversized line without buffering. */
export const MAX_TRANSCRIPT_SINGLE_LINE_BYTES = 16 * 1024 * 1024;

/** Maximum bytes read for single-envelope OpenCode export JSON transcripts
 * (matches the runner capture side's 32 MiB RLIMIT_FSIZE bound). */
export const OPENCODE_EXPORT_MAX_BYTES = 32 * 1024 * 1024;

const MAX_OVERSIZED_LINE_SCAN_BYTES = 64 * 1024 * 1024;

/**
 * Naming convention documented (not just used) here: see
 * infra/terraform/main.tf's `google_storage_bucket.transcripts` — provisioned
 * as `<projectId>-session-transcripts` (currently
 * `agent-lcars-session-transcripts`; both watched repos' runners write into
 * this one shared project — see issue #24 and
 * apps/telemetry-watcher/src/lib/config.ts's `transcriptsBucket`). Exported
 * so callers never need a bucket name literal of their own;
 * {@link fetchSessionTranscript} itself trusts the bucket embedded in each
 * doc's own `transcriptGcsUri` (the one piece of data actually written by
 * the shipper), not this derivation — this function exists for
 * documentation/verification, not as the operative source of the bucket
 * used per-fetch.
 */
export function getAgentSessionTranscriptsBucketName(): string {
  return `${getProjectId()}-session-transcripts`;
}

let cachedStorage: Storage | undefined;

/**
 * Direct `@google-cloud/storage` client, ambient Application Default
 * Credentials only — unlike `firestore-client.ts`'s Firestore reader, no
 * impersonation is needed here: the console's own runtime identity
 * (firebase-app-hosting-compute) is granted `roles/storage.objectViewer`
 * directly on the transcripts bucket (see agent-telemetry.yaml's storage
 * section), since transcripts are read with the console's own identity, not
 * a scoped reader SA. Uses the direct SDK client for GCS rather than pulling
 * in `firebase-admin/storage` (which would require initializing a
 * firebase-admin App this app has never needed for anything else).
 */
function getTranscriptStorageClient(): Storage {
  if (!cachedStorage) {
    cachedStorage = new Storage({ projectId: getProjectId() });
  }
  return cachedStorage;
}

interface ParsedGcsUri {
  bucket: string;
  object: string;
}

function parseGcsUri(uri: string): ParsedGcsUri | undefined {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) {
    return undefined;
  }
  return { bucket: match[1], object: match[2] };
}

function isRangeNotSatisfiableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  if (
    record.code === 416 ||
    record.status === 416 ||
    record.statusCode === 416
  ) {
    return true;
  }
  return (
    typeof record.message === 'string' &&
    /range not satisfiable|\b416\b/iu.test(record.message)
  );
}

export interface FetchTranscriptByteRangeOptions {
  startOffset: number;
  maxBytes?: number;
  maxSingleLineBytes?: number;
}

export interface FetchedTranscriptByteRange {
  chunk: Buffer;
  eof: boolean;
  /** Present when a single newline-free line exceeded `maxSingleLineBytes` and
   * was scanned past without buffering so pagination never stalls or OOMs. */
  skippedOversizedLine?: {
    nextOffset: number;
  };
}

async function readBoundedRange(
  readSlice: (start: number, endInclusive: number) => Promise<Buffer>,
  options: FetchTranscriptByteRangeOptions,
): Promise<FetchedTranscriptByteRange> {
  const startOffset = options.startOffset;
  const maxBytes = options.maxBytes ?? DEFAULT_TRANSCRIPT_PAGE_BYTES;
  const maxSingleLineBytes =
    options.maxSingleLineBytes ?? MAX_TRANSCRIPT_SINGLE_LINE_BYTES;

  if (!Number.isSafeInteger(startOffset) || startOffset < 0 || maxBytes <= 0) {
    throw new Error('Invalid transcript byte range');
  }

  const chunks: Buffer[] = [];
  let currentOffset = startOffset;
  let bufferedBytes = 0;
  let eof = false;
  let hasNewline = false;

  while (bufferedBytes < maxSingleLineBytes) {
    const stepBytes = Math.min(maxBytes, maxSingleLineBytes - bufferedBytes);
    // Request stepBytes + 1 (`[currentOffset, currentOffset + stepBytes]`) so
    // receiving <= stepBytes proves EOF without a separate GCS metadata RPC.
    const raw = await readSlice(currentOffset, currentOffset + stepBytes);
    if (raw.length <= stepBytes) {
      eof = true;
      if (raw.length > 0) {
        if (raw.includes(0x0a)) hasNewline = true;
        chunks.push(raw);
      }
      break;
    }

    const window = raw.subarray(0, stepBytes);
    if (window.includes(0x0a)) {
      hasNewline = true;
    }
    chunks.push(window);
    bufferedBytes += window.length;
    currentOffset += window.length;

    if (hasNewline) {
      break;
    }
  }

  if (eof || hasNewline) {
    return {
      chunk: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks),
      eof,
    };
  }

  // Single newline-free line exceeded maxSingleLineBytes: release buffered
  // bytes and scan forward in bounded windows to find the terminating newline.
  chunks.length = 0;
  const scanCeiling = Math.max(
    MAX_OVERSIZED_LINE_SCAN_BYTES,
    maxSingleLineBytes * 2,
  );
  let scannedPastCap = 0;
  while (scannedPastCap < scanCeiling) {
    const stepBytes = Math.min(maxBytes, scanCeiling - scannedPastCap);
    const raw = await readSlice(currentOffset, currentOffset + stepBytes);
    const hitEof = raw.length <= stepBytes;
    const window = hitEof ? raw : raw.subarray(0, stepBytes);
    const nl = window.indexOf(0x0a);
    if (nl !== -1) {
      const nextOffset = currentOffset + nl + 1;
      const eofAtNewline = hitEof && nl + 1 === window.length;
      return {
        chunk: Buffer.alloc(0),
        eof: eofAtNewline,
        skippedOversizedLine: { nextOffset },
      };
    }
    currentOffset += window.length;
    scannedPastCap += window.length;
    if (hitEof) {
      return {
        chunk: Buffer.alloc(0),
        eof: true,
        skippedOversizedLine: { nextOffset: currentOffset },
      };
    }
  }

  throw new Error('Transcript line exceeds maximum scan limit');
}

/**
 * Pure in-memory counterpart to {@link fetchSessionTranscriptByteRange} used by
 * hermetic E2E fixtures so E2E and unit tests exercise identical byte-range
 * slicing, newline extension, and oversized-line skipping behavior.
 */
export async function sliceTranscriptByteRangeFromBuffer(
  source: Buffer,
  options: FetchTranscriptByteRangeOptions,
): Promise<FetchedTranscriptByteRange> {
  return readBoundedRange(async (start, endInclusive) => {
    if (start >= source.length) {
      return Buffer.alloc(0);
    }
    return source.subarray(start, Math.min(source.length, endInclusive + 1));
  }, options);
}

/**
 * Reads a bounded byte range from a session's archived transcript in GCS.
 * Extends across `maxBytes` windows up to `maxSingleLineBytes` if a single
 * JSONL line exceeds `maxBytes`, and handles HTTP 416 (empty object or offset
 * at/past EOF) cleanly as `{ chunk: empty, eof: true }`.
 */
export async function fetchSessionTranscriptByteRange(
  gcsUri: string,
  options: FetchTranscriptByteRangeOptions,
): Promise<FetchedTranscriptByteRange> {
  const parsed = parseGcsUri(gcsUri);
  if (!parsed) {
    throw new Error(`Malformed transcript GCS URI: ${gcsUri}`);
  }
  const storage = getTranscriptStorageClient();
  const file = storage.bucket(parsed.bucket).file(parsed.object);

  return readBoundedRange(async (start, endInclusive) => {
    const maxExpected = endInclusive - start + 1;
    const stream = file.createReadStream({
      start,
      end: endInclusive,
      decompress: false,
    });
    const parts: Buffer[] = [];
    let total = 0;
    try {
      for await (const piece of stream) {
        const bytes = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
        parts.push(bytes);
        total += bytes.length;
        if (total >= maxExpected) {
          break;
        }
      }
      const combined = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      return combined.length > maxExpected
        ? combined.subarray(0, maxExpected)
        : combined;
    } catch (error) {
      if (isRangeNotSatisfiableError(error)) {
        return Buffer.alloc(0);
      }
      throw error;
    } finally {
      stream.destroy();
    }
  }, options);
}

/**
 * Downloads and decodes a session's archived transcript from GCS, given the
 * `gs://` URI stored on its `SessionDoc.transcriptGcsUri`. `maxBytes` bounds
 * whole-envelope reads (such as OpenCode `*.export.json`) without buffering
 * arbitrary object sizes.
 *
 * Throws on any failure (malformed URI, object not found, network/auth
 * error) — callers (the console's session detail page) are expected to
 * catch and fail soft to a warning banner rather than a 500, matching every
 * other degraded-read path in this app (see cli-sessions.ts/
 * runner-sessions.ts).
 */
export async function fetchSessionTranscript(
  gcsUri: string,
  maxBytes?: number,
): Promise<string> {
  const parsed = parseGcsUri(gcsUri);
  if (!parsed) {
    throw new Error(`Malformed transcript GCS URI: ${gcsUri}`);
  }
  const storage = getTranscriptStorageClient();
  if (maxBytes !== undefined) {
    const stream = storage
      .bucket(parsed.bucket)
      .file(parsed.object)
      .createReadStream();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes) throw new Error('Transcript exceeds size limit');
        chunks.push(bytes);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      stream.destroy();
    }
  }
  const [contents] = await storage
    .bucket(parsed.bucket)
    .file(parsed.object)
    .download();
  return contents.toString('utf-8');
}

/** @internal Reset the cached client for testing only. */
export function _resetTranscriptStoreForTesting(): void {
  cachedStorage = undefined;
}
