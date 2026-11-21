import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_TRANSCRIPT_LINE_BYTES } from '../lib/cli-transcript-archive';

const mockDownload = vi.fn();
const mockCreateReadStream = vi.fn();
const mockFile = vi.fn().mockImplementation(() => ({
  download: mockDownload,
  createReadStream: mockCreateReadStream,
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

vi.mock('@agent-lcars/util-server', async () => ({
  ...(await vi.importActual('@agent-lcars/util-server')),
  getProjectId: vi.fn().mockReturnValue('test-project'),
}));

import {
  _resetTranscriptStoreForTesting,
  fetchSessionTranscript,
  fetchSessionTranscriptByteRange,
  getAgentSessionTranscriptsBucketName,
  MAX_TRANSCRIPT_SINGLE_LINE_BYTES,
  sliceTranscriptByteRangeFromBuffer,
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
});

describe('bounded storage reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetTranscriptStoreForTesting();
  });
  it('decodes the stream at the bound without downloading an unbounded object', async () => {
    mockCreateReadStream.mockReturnValue(
      Readable.from([Buffer.from('abc'), Buffer.from('def')]),
    );
    expect(await fetchSessionTranscript('gs://bucket/cli/a.jsonl', 6)).toBe(
      'abcdef',
    );
    expect(mockDownload).not.toHaveBeenCalled();
  });
  it('aborts an oversized stream rather than rendering partial or unbounded content', async () => {
    const stream = Readable.from([Buffer.from('abcdefg')]);
    mockCreateReadStream.mockReturnValue(stream);
    await expect(
      fetchSessionTranscript('gs://bucket/cli/a.jsonl', 6),
    ).rejects.toThrow('size limit');
    expect(stream.destroyed).toBe(true);
  });
});

describe('fetchSessionTranscriptByteRange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetTranscriptStoreForTesting();
  });

  function mockGcsBackingBuffer(backing: Buffer) {
    mockCreateReadStream.mockImplementation(
      ({ start, end }: { start: number; end: number }) => {
        if (start >= backing.length) {
          return Readable.from(
            (async function* () {
              const err = Object.assign(new Error('Range Not Satisfiable'), {
                code: 416,
              });
              throw err;
              yield Buffer.alloc(0);
            })(),
          );
        }
        return Readable.from([
          backing.subarray(start, Math.min(backing.length, end + 1)),
        ]);
      },
    );
  }

  it('shares the exact 32 MiB single-line payload ceiling with CLI validation', () => {
    expect(MAX_TRANSCRIPT_SINGLE_LINE_BYTES).toBe(MAX_TRANSCRIPT_LINE_BYTES);
    expect(MAX_TRANSCRIPT_SINGLE_LINE_BYTES).toBe(32 * 1024 * 1024);
  });

  it('reads maxBytes + 1 to detect non-EOF vs EOF without a metadata RPC', async () => {
    const backing = Buffer.from('line1\nline2\nline3\n', 'utf8');
    mockGcsBackingBuffer(backing);

    const first = await fetchSessionTranscriptByteRange(
      'gs://bucket/runs/1/a.jsonl',
      { startOffset: 0, maxBytes: 10 },
    );
    expect(first.eof).toBe(false);
    expect(first.chunk.toString('utf8')).toBe('line1\nline');
    expect(mockCreateReadStream).toHaveBeenCalledWith({
      start: 0,
      end: 10,
      decompress: false,
    });

    const second = await fetchSessionTranscriptByteRange(
      'gs://bucket/runs/1/a.jsonl',
      { startOffset: 6, maxBytes: 20 },
    );
    expect(second.eof).toBe(true);
    expect(second.chunk.toString('utf8')).toBe('line2\nline3\n');
  });

  it('treats HTTP 416 (empty object or offset at EOF) as an empty EOF slice', async () => {
    mockGcsBackingBuffer(Buffer.alloc(0));

    const empty = await fetchSessionTranscriptByteRange(
      'gs://bucket/runs/1/empty.jsonl',
      { startOffset: 0, maxBytes: 1024 },
    );
    expect(empty).toEqual({ chunk: Buffer.alloc(0), eof: true });
  });

  it('extends reads across windows when a single JSONL line exceeds maxBytes', async () => {
    const longLine = `{"big":"${'x'.repeat(250)}"}\n{"next":true}\n`;
    const backing = Buffer.from(longLine, 'utf8');
    mockGcsBackingBuffer(backing);

    const range = await fetchSessionTranscriptByteRange(
      'gs://bucket/runs/1/long-line.jsonl',
      { startOffset: 0, maxBytes: 64, maxSingleLineBytes: 1024 },
    );
    expect(range.chunk.includes(0x0a)).toBe(true);
    expect(range.chunk.toString('utf8')).toContain(
      `"big":"${'x'.repeat(250)}"`,
    );
    expect(mockCreateReadStream.mock.calls.length).toBeGreaterThan(1);
  });

  it('reads payloads at the exact maxSingleLineBytes ceiling with \\n, \\r\\n, or EOF, and skips limit + 1', async () => {
    const limit = 128;
    const exactPayload = 'x'.repeat(limit);

    for (const [raw, expectedEof] of [
      [`${exactPayload}\n{"next":1}\n`, false],
      [`${exactPayload}\n`, true],
      [`${exactPayload}\r\n{"next":1}\n`, false],
      [`${exactPayload}\r\n`, true],
      [exactPayload, true],
    ] as const) {
      const backing = Buffer.from(raw, 'utf8');
      mockGcsBackingBuffer(backing);
      const range = await fetchSessionTranscriptByteRange(
        'gs://bucket/runs/1/exact-limit.jsonl',
        { startOffset: 0, maxBytes: 64, maxSingleLineBytes: limit },
      );
      expect(range.skippedOversizedLine).toBeUndefined();
      expect(range.eof).toBe(expectedEof);
      expect(range.chunk.toString('utf8').startsWith(exactPayload)).toBe(true);

      const fromMem = await sliceTranscriptByteRangeFromBuffer(backing, {
        startOffset: 0,
        maxBytes: 64,
        maxSingleLineBytes: limit,
      });
      expect(fromMem).toEqual(range);
    }

    const overByOnePayload = 'y'.repeat(limit + 1);
    for (const [raw, expectedNextOffset, expectedEof] of [
      [`${overByOnePayload}\n{"after":1}\n`, limit + 2, false],
      [`${overByOnePayload}\r\n{"after":1}\n`, limit + 3, false],
      [overByOnePayload, limit + 1, true],
    ] as const) {
      const backing = Buffer.from(raw, 'utf8');
      mockGcsBackingBuffer(backing);
      const range = await fetchSessionTranscriptByteRange(
        'gs://bucket/runs/1/over-by-one.jsonl',
        { startOffset: 0, maxBytes: 64, maxSingleLineBytes: limit },
      );
      expect(range.chunk.length).toBe(0);
      expect(range.eof).toBe(expectedEof);
      expect(range.skippedOversizedLine).toEqual({
        nextOffset: expectedNextOffset,
      });

      const fromMem = await sliceTranscriptByteRangeFromBuffer(backing, {
        startOffset: 0,
        maxBytes: 64,
        maxSingleLineBytes: limit,
      });
      expect(fromMem).toEqual(range);
    }
  });

  it('scans past a single newline-free line exceeding maxSingleLineBytes without stalling', async () => {
    const oversized = `${'a'.repeat(300)}\n{"after":1}\n`;
    const backing = Buffer.from(oversized, 'utf8');
    mockGcsBackingBuffer(backing);

    const range = await fetchSessionTranscriptByteRange(
      'gs://bucket/runs/1/oversized.jsonl',
      { startOffset: 0, maxBytes: 64, maxSingleLineBytes: 128 },
    );
    expect(range.chunk.length).toBe(0);
    expect(range.eof).toBe(false);
    expect(range.skippedOversizedLine).toEqual({ nextOffset: 301 });

    // Confirm the in-memory E2E counterpart behaves identically.
    const fromMem = await sliceTranscriptByteRangeFromBuffer(backing, {
      startOffset: 0,
      maxBytes: 64,
      maxSingleLineBytes: 128,
    });
    expect(fromMem).toEqual(range);
  });
});
