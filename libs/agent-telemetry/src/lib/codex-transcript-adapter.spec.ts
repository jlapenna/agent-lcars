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
        cwd: '/home/jlapenna/p/members',
        model: 'gpt-5.6',
        permissionMode: 'on-request',
        title: 'Fix telemetry support',
        turns: 1,
        toolCallCounts: { exec: 1 },
        tokens: {
          inputTokens: 120,
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
});
