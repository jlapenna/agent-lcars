import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { codexAdapter } from './codex-transcript-adapter';

const fixture = fs
  .readFileSync(path.join(__dirname, 'fixtures', 'codex-session.jsonl'), 'utf8')
  .split('\n');

describe('codexAdapter', () => {
  it('reduces Codex rollout JSONL to summary-only telemetry', () => {
    expect(codexAdapter.reduce(fixture)).toEqual([
      expect.objectContaining({
        sessionId: 'codex-session-1',
        source: 'cli',
        agent: 'codex',
        cwd: '/home/developer/p/members',
        model: 'gpt-5.6',
        permissionMode: 'on-request',
        title: 'Fix telemetry support',
        titleSource: 'inferred',
        turns: 1,
        toolCallCounts: { exec: 1 },
        tokens: {
          inputTokens: 80,
          outputTokens: 30,
          cacheCreationTokens: 0,
          cacheReadTokens: 40,
        },
        lastToolCall: {
          name: 'exec',
          timestamp: '2026-07-20T10:00:04.000Z',
        },
        deliverables: {
          prNumbers: [42],
          commitShas: ['abcdef1234567'],
        },
      }),
    ]);
  });

  it('ignores malformed and unknown lines', () => {
    expect(() =>
      codexAdapter.reduce([...fixture, 'not-json', '{"type":"future"}']),
    ).not.toThrow();
  });

  it('returns no summary when session metadata is absent', () => {
    expect(codexAdapter.reduce(['{"type":"event_msg","payload":{}}'])).toEqual(
      [],
    );
  });

  it('drops an unsafe sessionId rather than passing it through', () => {
    expect(
      codexAdapter.reduce([
        JSON.stringify({
          type: 'session_meta',
          payload: { id: '../other-run/hijacked', cwd: '/tmp' },
        }),
      ]),
    ).toEqual([]);
  });

  it('never yields titleSource "declared" — a rollout-derived title is always "inferred", the only tier this adapter can populate (see applySessionTitleOverlay, which relies on producers never claiming the declared/generated tiers they did not earn)', () => {
    const [summary] = codexAdapter.reduce(fixture);
    expect(summary.titleSource).toBe('inferred');
    expect(summary.titleSource).not.toBe('declared');
  });

  it('clamps uncached input at zero for inconsistent upstream totals', () => {
    const lines = fixture.map((line) =>
      line.replace(
        '"input_tokens":120,"cached_input_tokens":40',
        '"input_tokens":20,"cached_input_tokens":40',
      ),
    );

    expect(codexAdapter.reduce(lines)[0].tokens).toEqual({
      inputTokens: 0,
      outputTokens: 30,
      cacheCreationTokens: 0,
      cacheReadTokens: 40,
    });
  });
});
