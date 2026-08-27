import { Storage } from '@google-cloud/storage';

export interface UploadTranscriptOptions {
  projectId?: string;
  bucket: string;
  object: string;
  contents: string;
}

let cachedStorage: Storage | undefined;
let cachedForProjectId: string | undefined;

function getStorageClient(projectId?: string): Storage {
  if (!cachedStorage || cachedForProjectId !== projectId) {
    cachedStorage = new Storage({ projectId });
    cachedForProjectId = projectId;
  }
  return cachedStorage;
}

/**
 * Uploads a session's raw transcript to the shared transcripts bucket
 * (issue #24) so it survives the runner container being destroyed on job
 * exit — this is the write-side counterpart to
 * `@agent-lcars/telemetry`'s `fetchSessionTranscript`, which trusts
 * whatever `gs://` URI ends up embedded in the doc rather than deriving a
 * bucket name itself. Throws on failure; callers (`finalize.ts`) are
 * expected to catch and fail soft, same as every other runner-mode write.
 */
export async function uploadTranscript(
  options: UploadTranscriptOptions,
): Promise<void> {
  await getStorageClient(options.projectId)
    .bucket(options.bucket)
    .file(options.object)
    .save(options.contents, { contentType: 'application/x-ndjson' });
}

/** @internal Reset the cached client for testing only. */
export function _resetTranscriptUploadForTesting(): void {
  cachedStorage = undefined;
  cachedForProjectId = undefined;
}

interface ParsedGcsUri {
  bucket: string;
  object: string;
}

function parseGcsUri(uri: string): ParsedGcsUri | undefined {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) return undefined;
  return { bucket: match[1] as string, object: match[2] as string };
}

/**
 * Downloads a transcript from GCS by its `gs://` URI -- the read-side
 * counterpart to `uploadTranscript`, sharing its cached `Storage` client
 * and credential wiring (sub-project 6's resume mechanism: the same
 * `telemetry_writer` identity that already uploads transcripts also
 * downloads them, needing no new IAM). Mirrors `libs/telemetry/src/server/
 * transcript-store.ts`'s `fetchSessionTranscript`, which this app cannot
 * import (that module is console-only, using the console's own
 * `roles/storage.objectViewer` grant and ambient ADC rather than an
 * explicit credentials file) -- a small, deliberate duplication at the
 * app-local-client boundary, the same shape this repo already accepts for
 * `.swcrc`/`.prettierrc`-style foundation files.
 */
export async function downloadTranscript(
  gcsUri: string,
  options: { projectId?: string } = {},
): Promise<string> {
  const parsed = parseGcsUri(gcsUri);
  if (!parsed) {
    throw new Error(`Malformed transcript GCS URI: ${gcsUri}`);
  }
  const [contents] = await getStorageClient(options.projectId)
    .bucket(parsed.bucket)
    .file(parsed.object)
    .download();
  return contents.toString('utf-8');
}
