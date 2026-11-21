import {
  fetchSessionTranscript,
  fetchSessionTranscriptByteRange,
  OPENCODE_EXPORT_MAX_BYTES,
} from '@agent-lcars/telemetry/server';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
  encodeTranscriptCursor,
  getSessionTranscript,
  parseTranscriptCursor,
} from './session-transcript';

vi.mock('@agent-lcars/telemetry/server', async () => {
  const actual = await vi.importActual<
    typeof import('@agent-lcars/telemetry/server')
  >('@agent-lcars/telemetry/server');
  return {
    ...actual,
    fetchSessionTranscript: vi.fn(),
    fetchSessionTranscriptByteRange: vi.fn(),
  };
});

describe('getSessionTranscript', () => {
  afterEach(() => vi.resetAllMocks());

  it('parses a fetched JSONL transcript page into timeline events', async () => {
    (fetchSessionTranscriptByteRange as Mock).mockResolvedValue({
      chunk: Buffer.from(
        JSON.stringify({
          type: 'user',
          isSidechain: false,
          sessionId: 's1',
          timestamp: '2026-07-01T00:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        }) + '\n',
        'utf8',
      ),
      eof: true,
    });

    const result = await getSessionTranscript('gs://bucket/runs/1/a.jsonl');

    expect(result).toEqual({
      events: [
        {
          kind: 'text',
          role: 'user',
          text: 'hi',
          timestamp: '2026-07-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('degrades to a warning and storageError flag when the GCS byte-range fetch fails', async () => {
    (fetchSessionTranscriptByteRange as Mock).mockRejectedValue(
      new Error('storage: not found'),
    );

    const result = await getSessionTranscript('gs://bucket/runs/1/a.jsonl');

    expect(result.events).toEqual([]);
    expect(result.storageError).toBe(true);
    expect(result.warning).toContain('storage');
  });

  it('parses a fetched Codex transcript with the selected agent parser', async () => {
    (fetchSessionTranscriptByteRange as Mock).mockResolvedValue({
      chunk: Buffer.from(
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-07-01T00:00:00.000Z',
          payload: { type: 'user_message', message: 'hello from codex' },
        }) + '\n',
        'utf8',
      ),
      eof: true,
    });

    const result = await getSessionTranscript(
      'gs://bucket/runs/1/codex.jsonl',
      'codex',
    );

    expect(result.events).toMatchObject([
      { kind: 'text', role: 'user', text: 'hello from codex' },
    ]);
  });

  it('surfaces a warning (but still returns the parsed events) when some lines are unparseable', async () => {
    (fetchSessionTranscriptByteRange as Mock).mockResolvedValue({
      chunk: Buffer.from(
        [
          'not json {{{',
          JSON.stringify({ type: 'queue-operation', sessionId: 's1' }),
        ].join('\n'),
        'utf8',
      ),
      eof: true,
    });

    const result = await getSessionTranscript('gs://bucket/runs/1/a.jsonl');

    expect(result.events).toEqual([]);
    expect(result.warning).toContain('could not be parsed');
  });

  it('paginates multi-page JSONL transcripts with carry-state cursors instead of truncating at 5 MiB', async () => {
    const line1 =
      JSON.stringify({
        type: 'user',
        isSidechain: false,
        message: { role: 'user', content: [{ type: 'text', text: 'page 1' }] },
      }) + '\n';
    const line2 =
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'page 2' }],
        },
      }) + '\n';
    const backing = Buffer.from(line1 + line2, 'utf8');
    (fetchSessionTranscriptByteRange as Mock).mockImplementation(
      async (_uri: string, { startOffset }: { startOffset: number }) => {
        if (startOffset === 0) {
          return {
            chunk: backing.subarray(0, Buffer.byteLength(line1, 'utf8')),
            eof: false,
          };
        }
        return {
          chunk: backing.subarray(startOffset),
          eof: true,
        };
      },
    );

    const first = await getSessionTranscript(
      'gs://cli-archives/cli/host/claude-code/a.jsonl',
      'claude-code',
      { pageBytes: 64 },
    );
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(first.events).toEqual([
      { kind: 'text', role: 'user', text: 'page 1', timestamp: undefined },
    ]);

    const cursor = parseTranscriptCursor(first.nextCursor!, 'claude-code');
    expect(cursor).toBeTruthy();

    const second = await getSessionTranscript(
      'gs://cli-archives/cli/host/claude-code/a.jsonl',
      'claude-code',
      { cursor, pageBytes: 64 },
    );
    expect(second.hasMore).toBeUndefined();
    expect(second.nextCursor).toBeUndefined();
    expect(second.events).toEqual([
      {
        kind: 'text',
        role: 'assistant',
        text: 'page 2',
        timestamp: undefined,
      },
    ]);
  });

  it('distinguishes empty and malformed OpenCode archives and bounds export download', async () => {
    (fetchSessionTranscript as Mock).mockResolvedValue(
      JSON.stringify({ info: { id: 'ses_empty' }, messages: [] }),
    );
    expect(
      await getSessionTranscript('gs://bucket/empty.export.json', 'opencode'),
    ).toEqual({ events: [] });
    expect(fetchSessionTranscript).toHaveBeenCalledWith(
      'gs://bucket/empty.export.json',
      OPENCODE_EXPORT_MAX_BYTES,
    );
    (fetchSessionTranscript as Mock).mockResolvedValue('{}');
    expect(
      await getSessionTranscript('gs://bucket/bad.export.json', 'opencode'),
    ).toMatchObject({
      events: [],
      warning: expect.stringContaining('malformed'),
    });
  });

  it('paginates large OpenCode exports across event pages', async () => {
    (fetchSessionTranscript as Mock).mockResolvedValue(
      JSON.stringify({
        info: { id: 'ses_paged' },
        messages: Array.from({ length: 5 }, (_, i) => ({
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: `turn ${i}` }],
        })),
      }),
    );

    const page1 = await getSessionTranscript(
      'gs://bucket/paged.export.json',
      'opencode',
      { pageEvents: 3 },
    );
    expect(page1.events).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    const cursor = parseTranscriptCursor(page1.nextCursor!, 'opencode');
    expect(cursor).toMatchObject({
      v: 1,
      agent: 'opencode',
      mode: 'events',
      offset: 3,
      snapshot: expect.any(String),
    });

    const page2 = await getSessionTranscript(
      'gs://bucket/paged.export.json',
      'opencode',
      { cursor, pageEvents: 3 },
    );
    expect(page2.events).toHaveLength(2);
    expect(page2.nextCursor).toBeUndefined();
  });

  it('elides a very long transcript that fits on page 1', async () => {
    const lines = Array.from({ length: 500 }, (_, i) =>
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        sessionId: 's1',
        timestamp: `2026-07-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `event ${i}` }],
        },
      }),
    );
    (fetchSessionTranscriptByteRange as Mock).mockResolvedValue({
      chunk: Buffer.from(lines.join('\n'), 'utf8'),
      eof: true,
    });

    const result = await getSessionTranscript('gs://bucket/runs/1/a.jsonl');

    expect(result.events.some((e) => e.kind === 'elision')).toBe(true);
    expect(result.events).toHaveLength(251);
  });

  it('validates cursor integrity against agent, mode, offset, and length', () => {
    const valid = encodeTranscriptCursor({
      v: 1,
      agent: 'codex',
      mode: 'bytes',
      offset: 1024,
      state: { pendingCodexTurnHash: 'u:5:abc:def' },
    });
    expect(parseTranscriptCursor(valid, 'codex')).toMatchObject({
      offset: 1024,
      state: { pendingCodexTurnHash: 'u:5:abc:def' },
    });
    expect(parseTranscriptCursor(valid, 'claude-code')).toBeUndefined();
    expect(parseTranscriptCursor('', 'codex')).toBeUndefined();
    expect(parseTranscriptCursor('a'.repeat(513), 'codex')).toBeUndefined();
    expect(
      parseTranscriptCursor(
        Buffer.from(
          JSON.stringify({ v: 1, agent: 'codex', mode: 'bytes', offset: 0 }),
        ).toString('base64url'),
        'codex',
      ),
    ).toBeUndefined();
    expect(
      parseTranscriptCursor(
        Buffer.from(
          JSON.stringify({
            v: 1,
            agent: 'codex',
            mode: 'events',
            offset: 10,
          }),
        ).toString('base64url'),
        'codex',
      ),
    ).toBeUndefined();
  });
});
