import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  elideTranscriptTimeline,
  isElisionDivider,
  isRenderableTranscriptAgent,
  mergeTranscriptTimelinePages,
  parseTranscriptTimeline,
  parseTranscriptTimelineChunk,
  type TranscriptPageParseState,
  type TranscriptTimelineEvent,
} from './transcript-timeline';
import type { SessionAgent } from './types';

function readFixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

describe('parseTranscriptTimeline', () => {
  it.each([null, [], 'invalid', 0])(
    'rejects a present malformed OpenCode tool state (%j)',
    (state) => {
      expect(
        parseTranscriptTimeline(
          JSON.stringify({
            info: { id: 'ses_malformed_tool' },
            messages: [
              {
                info: { role: 'assistant' },
                parts: [{ type: 'tool', tool: 'bash', state }],
              },
            ],
          }),
          'opencode',
        ),
      ).toEqual({ events: [], hadUnparseableLines: true });
    },
  );

  it('renders the full OpenCode export envelope, including completed and failed tools', () => {
    const parsed = parseTranscriptTimeline(
      readFixture('opencode-export.json'),
      'opencode',
    );
    expect(parsed.hadUnparseableLines).toBe(false);
    expect(parsed.events).toMatchObject([
      {
        kind: 'text',
        role: 'user',
        text: 'Review the archived session.',
        timestamp: '2026-08-18T11:29:30.573Z',
      },
      { kind: 'text', role: 'assistant' },
      {
        kind: 'tool_use',
        name: 'bash',
        inputJson: expect.stringContaining('archive checked'),
      },
      { kind: 'tool_result', content: expect.stringContaining('<img') },
      { kind: 'tool_use', name: 'read' },
      { kind: 'tool_result', content: 'File not found' },
    ]);
    expect(
      parseTranscriptTimeline(
        JSON.stringify(JSON.parse(readFixture('opencode-export.json'))),
        'opencode',
      ),
    ).toEqual(parsed);
  });

  it('renders redacted turns and tool metadata without inventing conversation content', () => {
    const parsed = parseTranscriptTimeline(
      readFixture('opencode-session.json'),
      'opencode',
    );
    expect(parsed.hadUnparseableLines).toBe(false);
    expect(parsed.events).toMatchObject([
      { kind: 'text', role: 'user', text: expect.stringContaining('redacted') },
      {
        kind: 'tool_use',
        name: 'bash',
        inputJson: expect.stringContaining('redacted'),
      },
    ]);
  });

  it('distinguishes valid empty OpenCode exports from malformed archives and retains valid turns', () => {
    expect(
      parseTranscriptTimeline(
        ' {"info":{"id":"ses_empty"},"messages":[]} ',
        'opencode',
      ),
    ).toEqual({ events: [], hadUnparseableLines: false });
    for (const raw of [
      '',
      'broken',
      '{}',
      '{"info":{"id":"ses_bad"},"messages":{}}',
    ]) {
      expect(parseTranscriptTimeline(raw, 'opencode')).toEqual({
        events: [],
        hadUnparseableLines: true,
      });
    }
    expect(
      parseTranscriptTimeline(
        JSON.stringify({
          info: { id: 'ses_partial' },
          messages: [
            null,
            {
              info: { role: 'user' },
              parts: [{ type: 'text', text: 'survives' }],
            },
          ],
        }),
        'opencode',
      ),
    ).toMatchObject({
      events: [{ kind: 'text', text: 'survives' }],
      hadUnparseableLines: true,
    });
  });

  it('keeps OpenCode text and tool input/output whole and collapses the middle of a long timeline', () => {
    const raw = JSON.stringify({
      info: { id: 'ses_long' },
      messages: Array.from({ length: 500 }, () => ({
        info: { role: 'assistant' },
        parts: [
          { type: 'text', text: 'x'.repeat(5000) },
          {
            type: 'tool',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'y'.repeat(5000) },
              output: 'z'.repeat(5000),
            },
          },
        ],
      })),
    });
    const parsed = parseTranscriptTimeline(raw, 'opencode');
    expect(parsed.hadUnparseableLines).toBe(false);
    expect(parsed.events.slice(0, 3)).toMatchObject([
      { text: 'x'.repeat(5000) },
      { inputJson: expect.stringContaining('y'.repeat(5000)) },
      { content: 'z'.repeat(5000) },
    ]);
    const elided = elideTranscriptTimeline(parsed.events);
    expect(elided).toHaveLength(251);
    const divider = elided.find(isElisionDivider)!;
    expect(divider.events).toHaveLength(parsed.events.length - 250);
  });

  it('renders a representative Codex rollout as shared timeline events', () => {
    const { events, hadUnparseableLines } = parseTranscriptTimeline(
      readFixture('codex-session.jsonl'),
      'codex',
    );

    expect(hadUnparseableLines).toBe(false);
    // Codex writes user/assistant messages in both event_msg and
    // response_item envelopes; each logical turn appears only once.
    expect(events).toMatchObject([
      { kind: 'text', role: 'user', text: 'Fix telemetry support' },
      {
        kind: 'text',
        role: 'assistant',
        text: 'I will inspect the telemetry code.',
      },
      { kind: 'tool_use', name: 'exec' },
      { kind: 'tool_result', content: expect.stringContaining('pull/42') },
      { kind: 'result', subtype: 'success', isError: false },
    ]);
  });

  it('tolerates malformed and metadata-only Codex lines', () => {
    const raw = `${readFixture('codex-session.jsonl')}\nnot json {{{\n${JSON.stringify({ type: 'future_record', payload: { type: 'new' } })}`;
    const { events, hadUnparseableLines } = parseTranscriptTimeline(
      raw,
      'codex',
    );

    expect(hadUnparseableLines).toBe(true);
    expect(events).toHaveLength(5);
  });

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

  it('keeps an oversized tool_use input whole for the view to collapse', () => {
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
    expect(toolUse.inputJson).toContain(hugeInput);
    expect(toolUse.inputJson).not.toContain('truncated');
  });

  it('returns no events for an empty transcript', () => {
    expect(parseTranscriptTimeline('')).toEqual({
      events: [],
      hadUnparseableLines: false,
    });
  });
});

describe('parseTranscriptTimelineChunk & mergeTranscriptTimelinePages', () => {
  function paginateBuffer(
    raw: string,
    pageBytes: number,
    agent: SessionAgent = 'claude-code',
  ) {
    const full = Buffer.from(raw, 'utf8');
    let offset = 0;
    let state: TranscriptPageParseState = {};
    let merged: (
      | TranscriptTimelineEvent
      | ReturnType<typeof elideTranscriptTimeline>[number]
    )[] = [];
    let hadUnparseableLines = false;
    let pages = 0;

    while (offset < full.length) {
      pages += 1;
      expect(pages).toBeLessThan(10_000);
      // Extend past pageBytes only when no newline exists in the window yet
      // (matching fetchSessionTranscriptByteRange's single-line extension).
      let end = Math.min(full.length, offset + pageBytes);
      while (end < full.length && !full.subarray(offset, end).includes(0x0a)) {
        end = Math.min(full.length, end + pageBytes);
      }
      const eof = end >= full.length;
      const chunk = full.subarray(offset, end);
      const parsed = parseTranscriptTimelineChunk(chunk, {
        startOffset: offset,
        eof,
        agent,
        initialState: state,
      });
      expect(parsed.nextOffset).toBeGreaterThan(offset);
      offset = parsed.nextOffset;
      state = parsed.nextState;
      if (parsed.hadUnparseableLines) hadUnparseableLines = true;
      merged = mergeTranscriptTimelinePages(merged, parsed.events);
    }

    return { events: merged, hadUnparseableLines, pages };
  }

  it('never parses partial multi-byte UTF-8 sequences at a non-EOF chunk boundary', () => {
    const line1 = JSON.stringify({
      type: 'user',
      isSidechain: false,
      message: { role: 'user', content: [{ type: 'text', text: 'first 🚀' }] },
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '🚀🔥€é multi-byte' }],
      },
    });
    const full = Buffer.from(`${line1}\n${line2}\n`, 'utf8');
    const emojiStart = full.indexOf(Buffer.from('🚀🔥€é', 'utf8'));
    // Cut right inside the 4-byte UTF-8 sequence of 🔥 in line 2.
    const cutOffset = emojiStart + 6;
    const page1 = parseTranscriptTimelineChunk(full.subarray(0, cutOffset), {
      startOffset: 0,
      eof: false,
    });
    expect(page1.hadUnparseableLines).toBe(false);
    expect(page1.nextOffset).toBe(Buffer.byteLength(`${line1}\n`, 'utf8'));
    expect(page1.events).toEqual([
      { kind: 'text', role: 'user', text: 'first 🚀', timestamp: undefined },
    ]);

    const page2 = parseTranscriptTimelineChunk(
      full.subarray(page1.nextOffset),
      {
        startOffset: page1.nextOffset,
        eof: true,
        initialState: page1.nextState,
      },
    );
    expect(page2.hadUnparseableLines).toBe(false);
    expect(page2.events).toEqual([
      {
        kind: 'text',
        role: 'assistant',
        text: '🚀🔥€é multi-byte',
        timestamp: undefined,
      },
    ]);
  });

  it('snaps back before an open sidechain or unpaired tool_use when an earlier safe cut exists', () => {
    const raw = readFixture('session-with-subagent.jsonl');
    const lines = raw.trim().split('\n');
    // Line 0 is queue-operation (0 events); line 1 is user text (safe, 1 event);
    // line 2 is Task tool_use (unsafe); line 3 is isSidechain:true (unsafe).
    const prefixWithOpenSidechain = `${lines.slice(0, 4).join('\n')}\n`;
    const chunk = Buffer.from(prefixWithOpenSidechain, 'utf8');

    const page1 = parseTranscriptTimelineChunk(chunk, {
      startOffset: 0,
      eof: false,
    });
    expect(page1.nextOffset).toBe(
      Buffer.byteLength(`${lines.slice(0, 2).join('\n')}\n`, 'utf8'),
    );
    expect(page1.events.map((e) => e.kind)).toEqual(['text']);
    expect(page1.nextState).toEqual({});

    const fullBuffer = Buffer.from(raw, 'utf8');
    const page2 = parseTranscriptTimelineChunk(
      fullBuffer.subarray(page1.nextOffset),
      {
        startOffset: page1.nextOffset,
        eof: true,
        initialState: page1.nextState,
      },
    );
    const merged = mergeTranscriptTimelinePages(page1.events, page2.events);
    expect(merged).toEqual(parseTranscriptTimeline(raw).events);
  });

  it('uses carry-state fallback and merges seamlessly when a giant sidechain spans multiple pages', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Grep', input: { q: 'one' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'match 1' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'still in subagent' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'back on main chain' }],
        },
      }),
    ];
    const raw = `${lines.join('\n')}\n`;
    // Force page 1 to contain only the first two sidechain lines (no earlier safe cut!).
    const page1Bytes = Buffer.from(`${lines[0]}\n${lines[1]}\n`, 'utf8');
    const page1 = parseTranscriptTimelineChunk(page1Bytes, {
      startOffset: 0,
      eof: false,
    });
    expect(page1.nextOffset).toBe(page1Bytes.length);
    expect(page1.nextState).toEqual({
      inSidechain: true,
      sidechainContributedEvents: true,
    });
    expect(page1.events).toHaveLength(1);
    expect(page1.events[0]).toMatchObject({ kind: 'sidechain-group' });

    const full = Buffer.from(raw, 'utf8');
    const page2 = parseTranscriptTimelineChunk(
      full.subarray(page1.nextOffset),
      {
        startOffset: page1.nextOffset,
        eof: true,
        initialState: page1.nextState,
      },
    );
    expect(page2.events[0]).toMatchObject({
      kind: 'sidechain-group',
      continuesPrevious: true,
    });

    const merged = mergeTranscriptTimelinePages(page1.events, page2.events);
    expect(merged).toEqual(parseTranscriptTimeline(raw).events);
  });

  it('keeps separate Claude subagent groups separate when a metadata-only separator closes group A and group B opens with progress-only records', () => {
    const groupAVisible = JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Grep', input: { q: 'group-a' } }],
      },
    });
    const nonSidechainMetadataSeparator = JSON.stringify({
      type: 'queue-operation',
      isSidechain: false,
      sessionId: 's1',
    });
    const groupBProgressOnly = JSON.stringify({
      type: 'progress',
      isSidechain: true,
      sessionId: 's1',
    });
    const groupBVisible = JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { p: 'group-b' } }],
      },
    });
    const trailingMain = JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
      },
    });

    const allLines = [
      groupAVisible,
      nonSidechainMetadataSeparator,
      groupBProgressOnly,
      groupBVisible,
      trailingMain,
    ];
    const raw = `${allLines.join('\n')}\n`;

    const chunk1Bytes = Buffer.from(`${groupAVisible}\n`, 'utf8');
    const chunk1 = parseTranscriptTimelineChunk(chunk1Bytes, {
      startOffset: 0,
      eof: false,
    });
    expect(chunk1.nextState).toEqual({
      inSidechain: true,
      sidechainContributedEvents: true,
    });

    const chunk2Bytes = Buffer.from(
      `${nonSidechainMetadataSeparator}\n${groupBProgressOnly}\n`,
      'utf8',
    );
    const chunk2 = parseTranscriptTimelineChunk(chunk2Bytes, {
      startOffset: chunk1.nextOffset,
      eof: false,
      initialState: chunk1.nextState,
    });
    expect(chunk2.events).toEqual([]);
    expect(chunk2.nextState).toEqual({ inSidechain: true });

    const full = Buffer.from(raw, 'utf8');
    const chunk3 = parseTranscriptTimelineChunk(
      full.subarray(chunk2.nextOffset),
      {
        startOffset: chunk2.nextOffset,
        eof: true,
        initialState: chunk2.nextState,
      },
    );
    expect(chunk3.events[0]).toMatchObject({ kind: 'sidechain-group' });
    expect(
      (
        chunk3.events[0] as Extract<
          TranscriptTimelineEvent,
          { kind: 'sidechain-group' }
        >
      ).continuesPrevious,
    ).toBeUndefined();

    const afterChunk2 = mergeTranscriptTimelinePages(
      chunk1.events,
      chunk2.events,
    );
    const finalMerged = mergeTranscriptTimelinePages(
      afterChunk2,
      chunk3.events,
    );
    expect(finalMerged).toEqual(parseTranscriptTimeline(raw).events);
    expect(
      finalMerged.filter((event) => event.kind === 'sidechain-group'),
    ).toHaveLength(2);
  });

  it('deduplicates Codex event_msg and response_item turns across page boundaries even with intervening metadata', () => {
    const lines = [
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-10-01T00:00:00Z',
        payload: { type: 'user_message', message: 'Large prompt across pages' },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: { cwd: '/repo' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-10-01T00:00:00Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Large prompt across pages' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-10-01T00:00:01Z',
        payload: { type: 'agent_message', message: 'Done.' },
      }),
    ];
    const raw = `${lines.join('\n')}\n`;
    const firstChunk = Buffer.from(`${lines[0]}\n${lines[1]}\n`, 'utf8');
    const page1 = parseTranscriptTimelineChunk(firstChunk, {
      startOffset: 0,
      eof: false,
      agent: 'codex',
    });
    expect(page1.events).toHaveLength(1);
    expect(page1.nextState.pendingCodexTurnHash).toBeTruthy();

    const full = Buffer.from(raw, 'utf8');
    const page2 = parseTranscriptTimelineChunk(
      full.subarray(page1.nextOffset),
      {
        startOffset: page1.nextOffset,
        eof: true,
        agent: 'codex',
        initialState: page1.nextState,
      },
    );
    const merged = mergeTranscriptTimelinePages(page1.events, page2.events);
    expect(merged).toEqual(parseTranscriptTimeline(raw, 'codex').events);
  });

  it.each([
    ['normal-session.jsonl', 'claude-code'],
    ['session-with-subagent.jsonl', 'claude-code'],
    ['session-with-result.jsonl', 'claude-code'],
    ['session-unknown-line-type.jsonl', 'claude-code'],
    ['codex-session.jsonl', 'codex'],
  ] as const)(
    'reproduces whole-transcript output identically across arbitrary byte page sizes for %s',
    (fixtureName, agent) => {
      const raw = readFixture(fixtureName);
      const expected = parseTranscriptTimeline(raw, agent);
      for (const pageBytes of [180, 350, 700]) {
        const paged = paginateBuffer(raw, pageBytes, agent);
        expect(paged.events).toEqual(expected.events);
        expect(paged.hadUnparseableLines).toBe(expected.hadUnparseableLines);
      }
    },
  );
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

  it('keeps the first 50 and last 200 events expanded and collapses every other event', () => {
    const events = makeEvents(500);

    const result = elideTranscriptTimeline(events);

    expect(result).toHaveLength(251);
    expect(result[0]).toEqual(events[0]);
    expect(result[49]).toEqual(events[49]);
    expect(result[50]).toEqual({
      kind: 'elision',
      elidedCount: 250,
      events: events.slice(50, 300),
    });
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

describe('isRenderableTranscriptAgent', () => {
  it('is true for supported timeline formats', () => {
    expect(isRenderableTranscriptAgent('claude-code')).toBe(true);
    expect(isRenderableTranscriptAgent('codex')).toBe(true);
  });

  // Codex has a working TranscriptAdapter for stats summarization
  // (transcript-adapter.ts), but its raw rollout JSONL uses a completely
  // different line shape than parseTranscriptTimeline's message.content
  // walk expects (see codex-transcript-adapter.spec.ts's fixture) -
  // conflating "has an adapter" with "renderable" was Bug 3 in
  // agent-lcars#645.
  it('supports OpenCode and Antigravity and rejects agents without a timeline parser', () => {
    expect(isRenderableTranscriptAgent('opencode')).toBe(true);
    expect(isRenderableTranscriptAgent('antigravity')).toBe(true);
    expect(isRenderableTranscriptAgent('gemini')).toBe(false);
  });
});
