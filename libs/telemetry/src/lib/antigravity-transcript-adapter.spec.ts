import { describe, expect, it } from 'vitest';

import { antigravityAdapter } from './antigravity-transcript-adapter';
import { parseTranscriptTimeline } from './transcript-timeline';

const SESSION_ID = '84a714ed-e6f4-4f95-9175-54368953f80f';
const BRAIN_PATH = `/home/user/.gemini/antigravity-cli/brain/${SESSION_ID}/.system_generated/logs/transcript.jsonl`;

const FIXTURE_LINES = [
  JSON.stringify({
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: '2026-11-05T18:13:22.435726387Z',
    content: '<USER_REQUEST>\nFix the telemetry pipeline\n</USER_REQUEST>',
  }),
  JSON.stringify({
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-05T18:13:28.886168186Z',
    content: 'Inspecting the repository.',
    input_tokens: 1200,
    cache_read_tokens: 400,
    output_tokens: 150,
    tool_calls: [
      {
        name: 'run_command',
        args: {
          CommandLine: JSON.stringify(
            'gh pr create --title "Fix telemetry" --body "Done"',
          ),
        },
      },
    ],
  }),
  JSON.stringify({
    step_index: 2,
    source: 'MODEL',
    type: 'GENERIC',
    status: 'DONE',
    created_at: '2026-11-05T18:13:30.000000000Z',
    content:
      'Command exited with code 0.\n\nCommand output:\n[feat/fix abc1234] Fix telemetry\nhttps://github.com/octo/example/pull/42\n',
  }),
];

describe('antigravityAdapter', () => {
  it('detects Antigravity transcripts by path or step line shape', () => {
    expect(antigravityAdapter.detect([], BRAIN_PATH)).toBe(true);
    expect(antigravityAdapter.detect(FIXTURE_LINES, '/tmp/other.jsonl')).toBe(
      true,
    );
    expect(
      antigravityAdapter.detect(['{"type":"other"}'], '/tmp/other.jsonl'),
    ).toBe(false);
  });

  it('reduces an Antigravity brain transcript into a SessionSummary', () => {
    const summaries = antigravityAdapter.reduce(FIXTURE_LINES, BRAIN_PATH);
    expect(summaries).toEqual([
      {
        sessionId: SESSION_ID,
        source: 'cli',
        agent: 'antigravity',
        startedAt: '2026-11-05T18:13:22.435726387Z',
        lastActivityAt: '2026-11-05T18:13:30.000000000Z',
        turns: 1,
        title: 'Fix the telemetry pipeline',
        titleSource: 'inferred',
        toolCallCounts: { run_command: 1 },
        lastToolCall: {
          name: 'run_command',
          timestamp: '2026-11-05T18:13:28.886168186Z',
        },
        tokens: {
          inputTokens: 1200,
          outputTokens: 150,
          cacheCreationTokens: 0,
          cacheReadTokens: 400,
        },
        deliverables: {
          prNumbers: [42],
          qualifiedPRs: [
            { repo: { owner: 'octo', name: 'example' }, number: 42 },
          ],
          commitShas: ['abc1234'],
        },
      },
    ]);
  });

  it('skips transcript_full.jsonl during recursive directory discovery to prevent duplicate session summaries', () => {
    const fullPath = BRAIN_PATH.replace(
      'transcript.jsonl',
      'transcript_full.jsonl',
    );
    expect(antigravityAdapter.reduce(FIXTURE_LINES, fullPath)).toEqual([]);
  });

  it('renders Antigravity transcript lines as timeline events', () => {
    const parsed = parseTranscriptTimeline(
      FIXTURE_LINES.join('\n'),
      'antigravity',
    );
    expect(parsed.hadUnparseableLines).toBe(false);
    expect(parsed.events).toEqual([
      {
        kind: 'text',
        role: 'user',
        text: 'Fix the telemetry pipeline',
        timestamp: '2026-11-05T18:13:22.435726387Z',
      },
      {
        kind: 'text',
        role: 'assistant',
        text: 'Inspecting the repository.',
        timestamp: '2026-11-05T18:13:28.886168186Z',
      },
      {
        kind: 'tool_use',
        name: 'run_command',
        inputJson: JSON.stringify(
          {
            CommandLine: JSON.stringify(
              'gh pr create --title "Fix telemetry" --body "Done"',
            ),
          },
          null,
          2,
        ),
        timestamp: '2026-11-05T18:13:28.886168186Z',
      },
      {
        kind: 'tool_result',
        content:
          'Command exited with code 0.\n\nCommand output:\n[feat/fix abc1234] Fix telemetry\nhttps://github.com/octo/example/pull/42\n',
        timestamp: '2026-11-05T18:13:30.000000000Z',
      },
    ]);
  });
});
