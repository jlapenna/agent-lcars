import { describe, expect, it } from 'vitest';

import { claudeCodeAdapter, codexAdapter } from './transcript-adapter';

const published = 'https://github.com/octo/example/pull/42';
const replayed = 'https://github.com/octo/other/pull/99';

describe.each(['claude', 'codex'] as const)(
  '%s publication result attribution',
  (provider) => {
    it.each(['failed', 'empty', 'successful'] as const)(
      'consumes a %s result once while retaining spend and display hints',
      (outcome) => {
        const output = outcome === 'empty' ? '' : published;
        const failed = outcome === 'failed';
        const rows =
          provider === 'claude'
            ? [
                {
                  type: 'assistant',
                  uuid: 'call-row',
                  sessionId: 'publication-results',
                  costUSD: 0.25,
                  message: {
                    role: 'assistant',
                    content: [
                      {
                        type: 'tool_use',
                        name: 'Bash',
                        id: 'create',
                        input: { command: 'gh pr create' },
                      },
                    ],
                  },
                },
                ...[output, replayed].map((content, index) => ({
                  type: 'user',
                  uuid: `result-${index}`,
                  sessionId: 'publication-results',
                  message: {
                    role: 'user',
                    content: [
                      {
                        type: 'tool_result',
                        tool_use_id: 'create',
                        is_error: index === 0 && failed,
                        content,
                      },
                    ],
                  },
                })),
              ]
            : [
                {
                  type: 'session_meta',
                  payload: {
                    id: 'publication-results',
                    originator: 'codex_cli',
                  },
                },
                {
                  type: 'event_msg',
                  payload: {
                    type: 'token_count',
                    info: {
                      total_token_usage: {
                        input_tokens: 120,
                        cached_input_tokens: 40,
                        output_tokens: 30,
                      },
                    },
                  },
                },
                {
                  type: 'response_item',
                  payload: {
                    type: 'function_call',
                    name: 'exec_command',
                    call_id: 'create',
                    arguments: JSON.stringify({ cmd: 'gh pr create' }),
                  },
                },
                ...[output, replayed].map((content, index) => ({
                  type: 'response_item',
                  payload: {
                    type: 'function_call_output',
                    call_id: 'create',
                    output: JSON.stringify({
                      exit_code: index === 0 && failed ? 1 : 0,
                      output: content,
                    }),
                  },
                })),
              ];
        const adapter =
          provider === 'claude' ? claudeCodeAdapter : codexAdapter;
        const [summary] = adapter.reduce(
          rows.map((row) => JSON.stringify(row)),
        );

        expect(summary.deliverables.qualifiedPRs).toEqual(
          outcome === 'successful'
            ? [{ repo: { owner: 'octo', name: 'example' }, number: 42 }]
            : undefined,
        );
        expect(summary.deliverables.prNumbers.includes(42)).toBe(
          outcome !== 'empty',
        );
        expect(
          provider === 'claude' ? summary.totalCostUsd : summary.tokens,
        ).toEqual(
          provider === 'claude'
            ? 0.25
            : {
                inputTokens: 80,
                outputTokens: 30,
                cacheReadTokens: 40,
                cacheCreationTokens: 0,
              },
        );
      },
    );
  },
);
