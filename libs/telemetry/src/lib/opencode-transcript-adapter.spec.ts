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

  it('carries an allowlisted physical backend observation into the summary', () => {
    const summary = opencodeAdapter.reduce([
      JSON.stringify({
        info: { id: 'ses_routed', resolvedModel: 'qwen3.8-flash-next' },
        messages: [],
      }),
    ]);

    expect(summary[0]?.resolvedModel).toBe('qwen3.8-flash-next');
  });

  it('reduces an OpenCode 2 session export and context snapshot to summary-only telemetry', () => {
    expect(
      opencodeAdapter.reduce([
        JSON.stringify({
          info: {
            id: 'ses_opencode_v2',
            title: 'Migrate OpenCode plugins',
            location: { directory: '/home/runner/_work/agent-lcars/repo' },
            model: { id: 'default', providerID: 'homelab' },
            cost: 0.42,
            tokens: {
              input: 14500,
              output: 320,
              reasoning: 40,
              cache: { read: 8000, write: 500 },
            },
            time: { created: 1795292399000, updated: 1795292405000 },
          },
          messages: [
            {
              id: 'msg_u1',
              type: 'user',
              time: { created: 1795292399500 },
              content: [{ type: 'text', text: 'Inspect the config' }],
            },
            {
              id: 'msg_a1',
              type: 'assistant',
              model: { id: 'default', providerID: 'homelab' },
              time: { created: 1795292400000, completed: 1795292404000 },
              content: [
                {
                  type: 'tool',
                  id: 'call_1',
                  name: 'shell',
                  state: { status: 'completed' },
                  time: {
                    created: 1795292401000,
                    ran: 1795292402000,
                    completed: 1795292403500,
                  },
                },
                { type: 'text', text: 'Done.' },
              ],
            },
            {
              id: 'msg_idle',
              type: 'idle',
              outcome: 'succeeded',
              time: { created: 1795292405000 },
            },
          ],
        }),
      ]),
    ).toEqual([
      expect.objectContaining({
        sessionId: 'ses_opencode_v2',
        source: 'cli',
        agent: 'opencode',
        cwd: '/home/runner/_work/agent-lcars/repo',
        model: 'homelab/default',
        title: 'Migrate OpenCode plugins',
        turns: 1,
        toolCallCounts: { shell: 1 },
        tokens: {
          inputTokens: 14500,
          outputTokens: 320,
          cacheCreationTokens: 500,
          cacheReadTokens: 8000,
        },
        lastToolCall: {
          name: 'shell',
          timestamp: new Date(1795292403500).toISOString(),
        },
        totalCostUsd: 0.42,
      }),
    ]);
  });
});
