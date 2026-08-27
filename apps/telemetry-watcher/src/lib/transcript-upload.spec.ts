import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSave = vi.fn();
const mockDownload = vi.fn();
const mockFile = vi.fn().mockImplementation(() => ({
  save: mockSave,
  download: mockDownload,
}));
const mockBucket = vi.fn().mockImplementation(() => ({
  file: mockFile,
}));
// A plain recorder (not the `Storage` mock itself, which vi.mock's
// hoisting requires to be constructed inline in the factory below) so
// tests can assert what `new Storage(...)` was called with.
const mockStorageCtor = vi.fn();

vi.mock('@google-cloud/storage', () => ({
  // `new Storage()` requires a `function`/`class` mockImplementation, not an
  // arrow function - see libs/telemetry/src/server/transcript-store.test.ts
  // for the same pattern/rationale.
  Storage: vi.fn().mockImplementation(function (options: unknown) {
    mockStorageCtor(options);
    return { bucket: mockBucket };
  }),
}));

import {
  _resetTranscriptUploadForTesting,
  downloadTranscript,
  uploadTranscript,
} from './transcript-upload';

describe('uploadTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetTranscriptUploadForTesting();
  });

  it('saves the contents to the named bucket/object', async () => {
    mockSave.mockResolvedValue(undefined);

    await uploadTranscript({
      bucket: 'agent-lcars-session-transcripts',
      object: 'runs/123/claude-code/session-abc.jsonl',
      contents: '{"line":"one"}\n',
    });

    expect(mockBucket).toHaveBeenCalledWith('agent-lcars-session-transcripts');
    expect(mockFile).toHaveBeenCalledWith(
      'runs/123/claude-code/session-abc.jsonl',
    );
    expect(mockSave).toHaveBeenCalledWith('{"line":"one"}\n', {
      contentType: 'application/x-ndjson',
    });
  });

  it('propagates an upload failure to the caller', async () => {
    mockSave.mockRejectedValue(new Error('storage: permission denied'));

    await expect(
      uploadTranscript({
        bucket: 'bucket',
        object: 'runs/1/claude-code/a.jsonl',
        contents: '{}',
      }),
    ).rejects.toThrow('storage: permission denied');
  });
});

describe('downloadTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetTranscriptUploadForTesting();
  });

  it('parses the gs:// URI and downloads via the same client uploadTranscript uses', async () => {
    mockDownload.mockResolvedValue([Buffer.from('{"a":1}\n')]);

    const contents = await downloadTranscript(
      'gs://agent-lcars-session-transcripts/runs/x/claude-code/sess_1.jsonl',
    );

    expect(mockBucket).toHaveBeenCalledWith('agent-lcars-session-transcripts');
    expect(mockFile).toHaveBeenCalledWith('runs/x/claude-code/sess_1.jsonl');
    expect(contents).toBe('{"a":1}\n');
  });

  it('throws on a malformed URI', async () => {
    await expect(downloadTranscript('not-a-gs-uri')).rejects.toThrow(
      /Malformed transcript GCS URI/,
    );
  });

  it('rejects a gs:// URI with no object path', async () => {
    await expect(downloadTranscript('gs://bucket-only')).rejects.toThrow(
      /Malformed transcript GCS URI/,
    );
  });

  it('rejects a URI with a non-gs:// scheme', async () => {
    await expect(
      downloadTranscript('s3://bucket/runs/x/claude-code/sess_1.jsonl'),
    ).rejects.toThrow(/Malformed transcript GCS URI/);
  });

  // The plan review's finding: AGENT_TELEMETRY_PROJECT_ID must reach the
  // download path, not just uploadTranscript's. getStorageClient caches by
  // projectId (see transcript-upload.ts), so this also proves the client
  // construction, not just the bucket/object lookup, threads it through.
  it('passes the project id to the same cached Storage client uploadTranscript uses', async () => {
    mockDownload.mockResolvedValue([Buffer.from('{}\n')]);

    await downloadTranscript('gs://bucket/object.jsonl', {
      projectId: 'test-project',
    });

    expect(mockStorageCtor).toHaveBeenCalledWith({
      projectId: 'test-project',
    });
  });

  it('propagates a download failure to the caller', async () => {
    mockDownload.mockRejectedValue(new Error('storage: object not found'));

    await expect(
      downloadTranscript('gs://bucket/runs/1/session.jsonl'),
    ).rejects.toThrow('storage: object not found');
  });
});
