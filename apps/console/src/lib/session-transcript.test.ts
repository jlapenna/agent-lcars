import { fetchSessionTranscript } from '@agent-lcars/telemetry/server';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { getSessionTranscript } from './session-transcript';

vi.mock('@agent-lcars/telemetry/server', () => ({
  fetchSessionTranscript: vi.fn(),
}));

describe('getSessionTranscript', () => {
  afterEach(() => vi.resetAllMocks());

  it('parses a fetched transcript into timeline events', async () => {
    (fetchSessionTranscript as Mock).mockResolvedValue(
      JSON.stringify({
        type: 'user',
        isSidechain: false,
        sessionId: 's1',
        timestamp: '2026-07-01T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      }),
    );

    const result = await getSessionTranscript('gs://bucket/runs/1/a.jsonl');

    expect(result.events).toEqual([
      {
        kind: 'text',
        role: 'user',
        text: 'hi',
        timestamp: '2026-07-01T00:00:00.000Z',
      },
    ]);
    expect(result.warning).toBeUndefined();
  });

  it('degrades to a warning and no events when the GCS fetch fails', async () => {
    (fetchSessionTranscript as Mock).mockRejectedValue(
      new Error('storage: not found'),
    );

    const result = await getSessionTranscript('gs://bucket/runs/1/a.jsonl');

    expect(result.events).toEqual([]);
    expect(result.warning).toContain('storage');
  });

  it('surfaces a warning (but still returns the parsed events) when some lines are unparseable', async () => {
    (fetchSessionTranscript as Mock).mockResolvedValue(
      [
        'not json {{{',
        JSON.stringify({ type: 'queue-operation', sessionId: 's1' }),
      ].join('\n'),
    );

    const result = await getSessionTranscript('gs://bucket/runs/1/a.jsonl');

    expect(result.events).toEqual([]);
    expect(result.warning).toContain('could not be parsed');
  });

  it('elides a very long transcript', async () => {
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
    (fetchSessionTranscript as Mock).mockResolvedValue(lines.join('\n'));

    const result = await getSessionTranscript('gs://bucket/runs/1/a.jsonl');

    expect(result.events.some((e) => e.kind === 'elision')).toBe(true);
    expect(result.events).toHaveLength(251);
  });
});
