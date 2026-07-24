import { Storage } from '@google-cloud/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSave = vi.fn();
const mockFile = vi.fn().mockImplementation(() => ({
  save: mockSave,
}));
const mockBucket = vi.fn().mockImplementation(() => ({
  file: mockFile,
}));

vi.mock('@google-cloud/storage', () => ({
  // `new Storage()` requires a `function`/`class` mockImplementation, not an
  // arrow function - see libs/telemetry/src/server/transcript-store.test.ts
  // for the same pattern/rationale.
  Storage: vi.fn().mockImplementation(function () {
    return { bucket: mockBucket };
  }),
}));

import {
  _resetTranscriptUploadForTesting,
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

  it('caches the storage client across calls for the same project id', async () => {
    mockSave.mockResolvedValue(undefined);

    await uploadTranscript({
      projectId: 'agent-lcars',
      bucket: 'b',
      object: 'a',
      contents: '{}',
    });
    await uploadTranscript({
      projectId: 'agent-lcars',
      bucket: 'b',
      object: 'c',
      contents: '{}',
    });

    expect(vi.mocked(Storage)).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the client when the project id changes', async () => {
    mockSave.mockResolvedValue(undefined);

    await uploadTranscript({
      projectId: 'agent-lcars',
      bucket: 'b',
      object: 'a',
      contents: '{}',
    });
    await uploadTranscript({
      projectId: 'supersprinklesracing',
      bucket: 'b',
      object: 'c',
      contents: '{}',
    });

    expect(vi.mocked(Storage)).toHaveBeenCalledTimes(2);
  });
});
