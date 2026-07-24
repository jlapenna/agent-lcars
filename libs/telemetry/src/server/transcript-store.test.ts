import { Storage } from '@google-cloud/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDownload = vi.fn();
const mockFile = vi.fn().mockImplementation(() => ({
  download: mockDownload,
}));
const mockBucket = vi.fn().mockImplementation(() => ({
  file: mockFile,
}));

vi.mock('@google-cloud/storage', () => ({
  // `new Storage()` requires a `function`/`class` mockImplementation, not an
  // arrow function - Vitest (unlike Jest) doesn't special-case arrow
  // functions used as automocked class constructors (see
  // libs/instagram/src/sync.test.ts for the same pattern).
  Storage: vi.fn().mockImplementation(function () {
    return { bucket: mockBucket };
  }),
}));

vi.mock('@repo/util-server', async () => ({
  ...(await vi.importActual('@repo/util-server')),
  getProjectId: vi.fn().mockReturnValue('test-project'),
}));

import {
  _resetTranscriptStoreForTesting,
  fetchSessionTranscript,
  getAgentSessionTranscriptsBucketName,
} from './transcript-store';

describe('getAgentSessionTranscriptsBucketName', () => {
  it('derives the bucket name from the project id convention', () => {
    expect(getAgentSessionTranscriptsBucketName()).toBe(
      'test-project-session-transcripts',
    );
  });
});

describe('fetchSessionTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetTranscriptStoreForTesting();
  });

  it('downloads and decodes the object named by the gs:// URI', async () => {
    mockDownload.mockResolvedValue([Buffer.from('{"line":"one"}\n')]);

    const content = await fetchSessionTranscript(
      'gs://test-project-agent-session-transcripts/runs/123/session-abc.jsonl',
    );

    expect(mockBucket).toHaveBeenCalledWith(
      'test-project-agent-session-transcripts',
    );
    expect(mockFile).toHaveBeenCalledWith('runs/123/session-abc.jsonl');
    expect(content).toBe('{"line":"one"}\n');
  });

  it('rejects a URI missing the gs:// scheme', async () => {
    await expect(
      fetchSessionTranscript('https://example.com/not-a-gcs-uri'),
    ).rejects.toThrow('Malformed transcript GCS URI');
  });

  it('rejects a gs:// URI with no object path', async () => {
    await expect(fetchSessionTranscript('gs://bucket-only')).rejects.toThrow(
      'Malformed transcript GCS URI',
    );
  });

  it('propagates a download failure (not-found, network, auth) to the caller', async () => {
    mockDownload.mockRejectedValue(new Error('storage: object not found'));

    await expect(
      fetchSessionTranscript('gs://bucket/runs/1/session.jsonl'),
    ).rejects.toThrow('storage: object not found');
  });

  it('caches the storage client across calls', async () => {
    mockDownload.mockResolvedValue([Buffer.from('{}')]);

    await fetchSessionTranscript('gs://bucket/runs/1/a.jsonl');
    await fetchSessionTranscript('gs://bucket/runs/2/b.jsonl');

    expect(vi.mocked(Storage)).toHaveBeenCalledTimes(1);
  });
});
