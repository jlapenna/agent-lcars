import 'server-only';

/** GCS boundary fixtures. Call only inside the hermetic E2E environment;
 * session reads, archive selection, parsing and rendering remain real. */
export const E2E_OPENCODE_SESSION_IDS = {
  full: 'e2e-opencode-full',
  empty: 'e2e-opencode-empty',
  malformed: 'e2e-opencode-malformed',
  unavailable: 'e2e-opencode-unavailable',
} as const;

export function getE2eTranscript(uri: string): string | undefined {
  if (!uri.startsWith('gs://e2e-transcripts/')) return undefined;
  const id = uri
    .split('/')
    .at(-1)
    ?.replace(/\.export\.json$/u, '');
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
