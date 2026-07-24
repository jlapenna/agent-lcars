import { Storage } from '@google-cloud/storage';
import { assertNotBrowser } from '@repo/util';
import { getProjectId } from '@repo/util-server';

assertNotBrowser();

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
 * a scoped reader SA. Mirrors the direct-SDK-client pattern already used by
 * `libs/instagram/src/sync.ts` for GCS rather than pulling in
 * `firebase-admin/storage` (which would require initializing a
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

/**
 * Downloads and decodes a session's archived transcript from GCS, given the
 * `gs://` URI stored on its `IssueAgentSessionDoc.transcriptGcsUri` (see
 * types.ts — CLI sessions never have one, only issue-agent runner sessions,
 * since the runner container that produced them is destroyed on exit).
 *
 * Throws on any failure (malformed URI, object not found, network/auth
 * error) — callers (the console's session detail page) are expected to
 * catch and fail soft to a warning banner rather than a 500, matching every
 * other degraded-read path in this app (see cli-sessions.ts/
 * runner-sessions.ts).
 */
export async function fetchSessionTranscript(gcsUri: string): Promise<string> {
  const parsed = parseGcsUri(gcsUri);
  if (!parsed) {
    throw new Error(`Malformed transcript GCS URI: ${gcsUri}`);
  }
  const storage = getTranscriptStorageClient();
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
