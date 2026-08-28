import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { opencodeAdapter } from './opencode-transcript-adapter';

const fixture = fs
  .readFileSync(
    path.join(__dirname, 'fixtures', 'opencode-session.json'),
    'utf8',
  )
  .split('\n');

describe('opencodeAdapter', () => {
  it('reduces the real opencode export envelope to summary-only telemetry', () => {
    expect(opencodeAdapter.reduce(fixture)).toEqual([
      expect.objectContaining({
        sessionId: 'ses_opencode_1',
        source: 'cli',
        agent: 'opencode',
        cwd: '/home/runner/_work/agent-lcars/agent-lcars',
        model: 'homelab/default',
        turns: 1,
        toolCallCounts: { bash: 1 },
        tokens: {
          inputTokens: 5587,
          outputTokens: 128,
          cacheCreationTokens: 12,
          cacheReadTokens: 175125,
        },
        lastToolCall: {
          name: 'bash',
          timestamp: '2026-08-18T11:31:42.281Z',
        },
        totalCostUsd: 0.25,
        deliverables: {
          prNumbers: [],
          commitShas: [],
        },
      }),
    ]);
  });

  it('tolerates malformed and future export content', () => {
    expect(opencodeAdapter.reduce(['not json'])).toEqual([]);
    expect(
      opencodeAdapter.reduce([
        JSON.stringify({ info: { id: 'ses_future' }, messages: [] }),
      ]),
    ).toEqual([
      expect.objectContaining({
        sessionId: 'ses_future',
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      }),
    ]);
  });

  it('drops an unsafe session id', () => {
    expect(
      opencodeAdapter.reduce([
        JSON.stringify({ info: { id: '../escape' }, messages: [] }),
      ]),
    ).toEqual([]);
  });
});
