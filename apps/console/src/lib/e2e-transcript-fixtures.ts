import 'server-only';

/** GCS boundary fixtures. Call only inside the hermetic E2E environment;
 * session reads, archive selection, parsing and rendering remain real. */
export const E2E_OPENCODE_SESSION_IDS = {
  full: 'e2e-opencode-full',
  empty: 'e2e-opencode-empty',
  malformed: 'e2e-opencode-malformed',
  unavailable: 'e2e-opencode-unavailable',
} as const;

export const E2E_ANTIGRAVITY_SESSION_IDS = {
  full: 'e2e-antigravity-full',
} as const;

export function getE2eTranscript(uri: string): string | undefined {
  if (!uri.startsWith('gs://e2e-transcripts/')) return undefined;
  const id = uri
    .split('/')
    .at(-1)
    ?.replace(/\.(?:export\.json|jsonl)$/u, '');
  if (id === E2E_ANTIGRAVITY_SESSION_IDS.full) {
    return [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-05T18:13:22.435726387Z',
        content:
          '<USER_REQUEST>\nAudit the Antigravity session archive.\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-05T18:13:28.886168186Z',
        content: 'Inspecting the Antigravity archive.',
        input_tokens: 1200,
        cache_read_tokens: 400,
        output_tokens: 150,
        tool_calls: [
          {
            name: 'run_command',
            args: {
              CommandLine: JSON.stringify('git status --short'),
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
        content: 'Command exited with code 0.\n\nCommand output:\nclean\n',
      }),
    ].join('\n');
  }
  if (id === E2E_OPENCODE_SESSION_IDS.unavailable) {
    throw new Error('Archived object missing or expired');
  }
  if (id === E2E_OPENCODE_SESSION_IDS.malformed) return '{broken export';
  if (id === E2E_OPENCODE_SESSION_IDS.empty) {
    return JSON.stringify({ info: { id }, messages: [] });
  }
  if (id !== E2E_OPENCODE_SESSION_IDS.full) return undefined;
  return JSON.stringify({
    info: { id },
    messages: [
      {
        info: { role: 'user' },
        parts: [{ type: 'text', text: 'Audit the OpenCode archive.' }],
      },
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: 'Archive review complete. <script>window.archiveInjected=true</script> [unsafe](javascript:alert(1))',
          },
          {
            type: 'tool',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'inspect archive' },
              output: '<img src=x onerror=alert(1)> archive checked',
            },
          },
          {
            type: 'tool',
            tool: 'read',
            state: {
              status: 'error',
              input: { filePath: 'missing.txt' },
              error: 'File not found',
            },
          },
        ],
      },
      ...Array.from({ length: 450 }, (_, i) => ({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: `Archived turn ${i}. ${'bounded content '.repeat(200)}`,
          },
        ],
      })),
    ],
  });
}
