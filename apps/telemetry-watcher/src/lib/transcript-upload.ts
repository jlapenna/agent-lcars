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
