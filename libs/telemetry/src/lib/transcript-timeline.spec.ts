import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  elideTranscriptTimeline,
  isElisionDivider,
  parseTranscriptTimeline,
  type TranscriptTimelineEvent,
} from './transcript-timeline';

function readFixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

describe('parseTranscriptTimeline', () => {
  it('renders user/assistant text and tool_use/tool_result turns in order', () => {
    const { events, hadUnparseableLines } = parseTranscriptTimeline(
      readFixture('normal-session.jsonl'),
    );

    expect(hadUnparseableLines).toBe(false);
    expect(events.map((e) => e.kind)).toEqual([
      'text', // user prompt
      'tool_use', // Bash npm test
      'tool_result', // 1 test failed
      'tool_use', // Edit
      'tool_result', // Applied edit
      'tool_use', // Bash gh pr create
      'tool_result', // PR url + commit sha
    ]);

    const [prompt] = events as [
      Extract<TranscriptTimelineEvent, { kind: 'text' }>,
    ];
    expect(prompt.role).toBe('user');
    expect(prompt.text).toBe('Please fix the flaky login test and open a PR.');

    const toolUse = events[1] as Extract<
      TranscriptTimelineEvent,
      { kind: 'tool_use' }
    >;
    expect(toolUse.name).toBe('Bash');
    expect(toolUse.inputJson).toContain('npm test');
  });

  it('renders a terminal result line as a result event', () => {
    const { events } = parseTranscriptTimeline(
      readFixture('session-with-result.jsonl'),
    );

    const result = events.at(-1) as Extract<
      TranscriptTimelineEvent,
      { kind: 'result' }
    >;
    expect(result.kind).toBe('result');
    expect(result.subtype).toBe('success');
    expect(result.isError).toBe(false);
  });

  it('groups a contiguous run of sidechain lines into one sidechain-group event', () => {
    const { events } = parseTranscriptTimeline(
      readFixture('session-with-subagent.jsonl'),
    );

    // main: user text, assistant tool_use(Task), [sidechain group],
    // tool_result(subagent summary), assistant text.
    expect(events.map((e) => e.kind)).toEqual([
      'text',
      'tool_use',
      'sidechain-group',
      'tool_result',
      'text',
    ]);

    const group = events[2] as Extract<
      TranscriptTimelineEvent,
      { kind: 'sidechain-group' }
    >;
    expect(group.events.map((e) => e.kind)).toEqual([
      'tool_use',
      'tool_result',
      'text',
    ]);
    expect(
      (
        group.events[0] as Extract<
          TranscriptTimelineEvent,
          { kind: 'tool_use' }
        >
      ).name,
    ).toBe('Grep');
  });

  it('skips malformed JSON and unrecognized-shape lines without throwing', () => {
    expect(() =>
      parseTranscriptTimeline(readFixture('session-unknown-line-type.jsonl')),
    ).not.toThrow();

    const { events, hadUnparseableLines } = parseTranscriptTimeline(
      readFixture('session-unknown-line-type.jsonl'),
    );

    expect(hadUnparseableLines).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(['text', 'text']);
  });

  it('flattens a tool_result content array of text blocks into one string', () => {
    const line = JSON.stringify({
      type: 'user',
      isSidechain: false,
      sessionId: 's1',
      timestamp: '2026-07-01T00:00:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
            ],
          },
        ],
      },
    });

    const { events } = parseTranscriptTimeline(line);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'tool_result',
      content: 'line one\nline two',
    });
  });

  it('truncates an oversized tool_use input rather than rendering it in full', () => {
    const hugeInput = 'x'.repeat(5000);
    const line = JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      sessionId: 's1',
      timestamp: '2026-07-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Write', input: { hugeInput } },
        ],
      },
    });

    const { events } = parseTranscriptTimeline(line);

    const toolUse = events[0] as Extract<
      TranscriptTimelineEvent,
      { kind: 'tool_use' }
    >;
    expect(toolUse.inputJson.length).toBeLessThan(hugeInput.length);
    expect(toolUse.inputJson).toContain('truncated');
  });

  it('returns no events for an empty transcript', () => {
    expect(parseTranscriptTimeline('')).toEqual({
      events: [],
      hadUnparseableLines: false,
    });
  });
});

describe('elideTranscriptTimeline', () => {
  function makeEvents(count: number): TranscriptTimelineEvent[] {
    return Array.from({ length: count }, (_, i) => ({
      kind: 'text',
      role: 'assistant',
      text: `event ${i}`,
    }));
  }

  it('returns events unchanged when at or under the threshold', () => {
    const events = makeEvents(400);
    expect(elideTranscriptTimeline(events)).toBe(events);
  });

  it('keeps the first 50 and last 200 events with a divider for the rest', () => {
    const events = makeEvents(500);

    const result = elideTranscriptTimeline(events);

    expect(result).toHaveLength(251);
    expect(result[0]).toEqual(events[0]);
    expect(result[49]).toEqual(events[49]);
    expect(result[50]).toEqual({ kind: 'elision', elidedCount: 250 });
    expect(result[51]).toEqual(events[300]);
    expect(result.at(-1)).toEqual(events.at(-1));
  });

  it('isElisionDivider distinguishes the divider from a real event', () => {
    const result = elideTranscriptTimeline(makeEvents(500));
    const divider = result.find(isElisionDivider);
    expect(divider?.elidedCount).toBe(250);
    const real = result.find((entry) => !isElisionDivider(entry));
    expect(isElisionDivider(real!)).toBe(false);
  });
});
