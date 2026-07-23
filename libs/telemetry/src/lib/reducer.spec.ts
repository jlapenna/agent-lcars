import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { reduceTranscript, reduceTranscripts } from './reducer';

function readFixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

describe('reduceTranscript', () => {
  it('reduces a normal session transcript into a summary', () => {
    const [summary] = reduceTranscript(readFixture('normal-session.jsonl'));

    expect(summary.sessionId).toBe('session-normal-1');
    expect(summary.source).toBe('issue-agent');
    expect(summary.agent).toBe('claude-code');
    expect(summary.cwd).toBe('/home/dev/project');
    expect(summary.branch).toBe('main');
    expect(summary.model).toBe('claude-sonnet-5');
    expect(summary.permissionMode).toBe('default');
    expect(summary.startedAt).toBe('2026-07-10T10:00:00.000Z');
    expect(summary.lastActivityAt).toBe('2026-07-10T10:10:02.000Z');
    expect(summary.turns).toBe(3);
    expect(summary.toolCallCounts).toEqual({ Bash: 2, Edit: 1 });
    expect(summary.tokens).toEqual({
      inputTokens: 450,
      outputTokens: 190,
      cacheCreationTokens: 10,
      cacheReadTokens: 155,
    });
    expect(summary.lastToolCall).toEqual({
      name: 'Bash',
      timestamp: '2026-07-10T10:10:00.000Z',
    });
    expect(summary.title).toBe('Fix flaky login test');
    expect(summary.deliverables.prNumbers).toEqual([42]);
    expect(summary.deliverables.commitShas).toEqual(['abc1234']);
  });

  it('falls back to a truncated first user prompt when no ai-title is present', () => {
    const longPrompt = 'x'.repeat(120);
    const content = [
      JSON.stringify({
        type: 'user',
        isSidechain: false,
        uuid: 'u1',
        timestamp: '2026-07-01T00:00:00.000Z',
        sessionId: 'session-no-title',
        message: {
          role: 'user',
          content: [{ type: 'text', text: longPrompt }],
        },
      }),
    ].join('\n');

    const [summary] = reduceTranscript(content);

    expect(summary.title).toHaveLength(80);
    expect(summary.title?.endsWith('…')).toBe(true);
  });

  it('ignores unknown line types and malformed JSON instead of throwing', () => {
    expect(() =>
      reduceTranscript(readFixture('session-unknown-line-type.jsonl')),
    ).not.toThrow();

    const [summary] = reduceTranscript(
      readFixture('session-unknown-line-type.jsonl'),
    );

    expect(summary.sessionId).toBe('session-unknown-1');
    expect(summary.turns).toBe(1);
    expect(summary.tokens.inputTokens).toBe(10);
    // The unknown line's timestamp is older than the assistant reply, so the
    // known line's timestamp should win for lastActivityAt.
    expect(summary.lastActivityAt).toBe('2026-07-09T08:00:03.000Z');
  });

  it('folds sidechain (subagent) lines under the parent session', () => {
    const summaries = reduceTranscript(
      readFixture('session-with-subagent.jsonl'),
    );

    expect(summaries).toHaveLength(1);
    const [summary] = summaries;
    expect(summary.sessionId).toBe('session-subagent-1');
    // Only the two top-level assistant turns count, not the subagent's.
    expect(summary.turns).toBe(2);
    // Tool calls from both the parent and the subagent are folded in.
    expect(summary.toolCallCounts).toEqual({ Task: 1, Grep: 1 });
    expect(summary.tokens.inputTokens).toBe(80 + 300 + 50 + 60);
    expect(summary.lastToolCall).toEqual({
      name: 'Grep',
      timestamp: '2026-07-11T09:00:20.000Z',
    });
  });

  it('counts streamed assistant blocks with the same message id once', () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 300,
    };
    const content = [
      {
        type: 'assistant',
        uuid: 'a1-thinking',
        sessionId: 'session-streamed',
        timestamp: '2026-07-21T12:00:00.000Z',
        message: {
          id: 'msg-one-response',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Working…' }],
          usage,
        },
      },
      {
        type: 'assistant',
        uuid: 'a1-tool-one',
        sessionId: 'session-streamed',
        timestamp: '2026-07-21T12:00:01.000Z',
        message: {
          id: 'msg-one-response',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }],
          usage,
        },
      },
      {
        type: 'assistant',
        uuid: 'a1-tool-two',
        sessionId: 'session-streamed',
        timestamp: '2026-07-21T12:00:02.000Z',
        message: {
          id: 'msg-one-response',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-2', name: 'Edit' }],
          usage,
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n');

    const [summary] = reduceTranscript(content);

    expect(summary.turns).toBe(1);
    expect(summary.tokens).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 20,
      cacheReadTokens: 300,
    });
    expect(summary.toolCallCounts).toEqual({ Read: 1, Edit: 1 });
  });

  it('reduces a resumed session spanning multiple files into one summary keyed by sessionId', () => {
    const summaries = reduceTranscripts([
      readFixture('resumed-session-part1.jsonl'),
      readFixture('resumed-session-part2.jsonl'),
    ]);

    expect(summaries).toHaveLength(1);
    const [summary] = summaries;

    expect(summary.sessionId).toBe('session-resumed-1');
    expect(summary.startedAt).toBe('2026-07-08T07:00:00.000Z');
    expect(summary.lastActivityAt).toBe('2026-07-09T07:30:12.000Z');
    expect(summary.turns).toBe(2);
    expect(summary.toolCallCounts).toEqual({ Read: 1, Bash: 1 });
    expect(summary.branch).toBe('feat/export');
    expect(summary.cwd).toBe(
      '/home/dev/project/.claude/worktrees/export-feature',
    );
    expect(summary.worktree).toBe(
      '/home/dev/project/.claude/worktrees/export-feature',
    );
    expect(summary.title).toBe('Finish CSV export feature');
    expect(summary.deliverables.commitShas).toEqual(['def5678']);
  });

  it('keeps distinct sessionIds within the same file as separate summaries', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        isSidechain: false,
        uuid: 'x1',
        timestamp: '2026-07-01T00:00:00.000Z',
        sessionId: 'session-a',
        message: { role: 'user', content: [{ type: 'text', text: 'hi a' }] },
      }),
      JSON.stringify({
        type: 'user',
        isSidechain: false,
        uuid: 'x2',
        timestamp: '2026-07-01T00:00:00.000Z',
        sessionId: 'session-b',
        message: { role: 'user', content: [{ type: 'text', text: 'hi b' }] },
      }),
    ].join('\n');

    const summaries = reduceTranscript(content);
    const ids = summaries.map((s) => s.sessionId).sort();

    expect(ids).toEqual(['session-a', 'session-b']);
  });

  it('deduplicates lines with the same uuid across overlapping files', () => {
    const shared = readFixture('resumed-session-part1.jsonl');
    const summaries = reduceTranscripts([shared, shared]);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].turns).toBe(1);
  });

  it('accumulates per-turn costUSD and captures the terminal result line', () => {
    const [summary] = reduceTranscript(
      readFixture('session-with-result.jsonl'),
    );

    expect(summary.totalCostUsd).toBeCloseTo(0.045 + 0.081);
    expect(summary.result).toEqual({ subtype: 'success', isError: false });
    expect(summary.deliverables.prNumbers).toEqual([99]);
  });

  it('captures an error_max_turns result line', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        isSidechain: false,
        uuid: 'u1',
        timestamp: '2026-07-16T00:00:00.000Z',
        sessionId: 'session-max-turns',
        entrypoint: 'claude-code-github-action',
        message: { role: 'user', content: [{ type: 'text', text: 'Go' }] },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        num_turns: 200,
        sessionId: 'session-max-turns',
        timestamp: '2026-07-16T01:00:00.000Z',
      }),
    ].join('\n');

    const [summary] = reduceTranscript(content);

    expect(summary.result).toEqual({
      subtype: 'error_max_turns',
      isError: true,
    });
  });

  it('omits totalCostUsd entirely when no line ever reported costUSD', () => {
    const [summary] = reduceTranscript(readFixture('normal-session.jsonl'));
    expect(summary).not.toHaveProperty('totalCostUsd');
  });

  it('always stamps agent: claude-code, regardless of source', () => {
    const [cliSummary] = reduceTranscript(
      readFixture('session-with-result.jsonl'),
    );
    expect(cliSummary.agent).toBe('claude-code');

    const content = JSON.stringify({
      type: 'user',
      isSidechain: false,
      uuid: 'u1',
      timestamp: '2026-07-16T00:00:00.000Z',
      sessionId: 'session-issue-agent',
      entrypoint: 'claude-code-github-action',
      message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
    });
    const [issueAgentSummary] = reduceTranscript(content);
    expect(issueAgentSummary.source).toBe('issue-agent');
    expect(issueAgentSummary.agent).toBe('claude-code');
  });

  it('ignores a result line missing subtype or is_error rather than throwing', () => {
    const content = JSON.stringify({
      type: 'result',
      sessionId: 'session-malformed-result',
      timestamp: '2026-07-16T00:00:00.000Z',
    });

    expect(() => reduceTranscript(content)).not.toThrow();
    const [summary] = reduceTranscript(content);
    expect(summary).not.toHaveProperty('result');
  });
});
