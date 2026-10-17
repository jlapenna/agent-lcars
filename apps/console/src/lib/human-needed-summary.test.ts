// @vitest-environment node

import type { RunResult } from '@agent-lcars/orchestrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handoffSummaryConfig,
  summarizeHumanNeeded,
} from './human-needed-summary';

const actions = [
  { text: 'Send the result back to resume work.' },
  {
    text: 'Inspect the deployment first.',
    command: 'deployctl status --target production',
  },
];
const result: RunResult = {
  ok: true,
  summary: 'park',
  message:
    'Human must run `deployctl status --target production`, then send the result back to resume work. Do not deploy yet.',
};
const fetchMock = vi.fn();
function response(value: unknown) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(value) } }],
    }),
  );
}
beforeEach(() => {
  vi.stubEnv(
    'AGENT_LCARS_HANDOFF_SUMMARY_URL',
    'https://summary.example.test/v1/chat/completions',
  );
  vi.stubEnv('AGENT_LCARS_HANDOFF_SUMMARY_API_KEY', 'test-only-key');
  vi.stubEnv('AGENT_LCARS_HANDOFF_SUMMARY_MODEL', 'small-summary-model');
  vi.stubGlobal('fetch', fetchMock.mockReset());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('human-needed summarization', () => {
  it('preserves the full handoff and prioritizes exact commands in a bounded pass', async () => {
    fetchMock.mockResolvedValue(response({ actions }));
    expect(await summarizeHumanNeeded(result)).toEqual({
      ...result,
      humanNeededActions: [actions[1], actions[0]],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://summary.example.test/v1/chat/completions');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'small-summary-model',
      messages: [
        { role: 'system', content: expect.any(String) },
        { role: 'user', content: result.message },
      ],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['pull-request', 'no-op', 'runner-failed'])(
    'does not spend a model call on %s',
    async (summary) => {
      expect(await summarizeHumanNeeded({ ...result, summary })).toEqual({
        ...result,
        summary,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('does not summarize a missing message or an unconfigured deployment', async () => {
    expect(await summarizeHumanNeeded({ ok: true, summary: 'park' })).toEqual({
      ok: true,
      summary: 'park',
    });
    vi.stubEnv('AGENT_LCARS_HANDOFF_SUMMARY_URL', '');
    vi.stubEnv('AGENT_LCARS_HANDOFF_SUMMARY_API_KEY', '');
    vi.stubEnv('AGENT_LCARS_HANDOFF_SUMMARY_MODEL', '');
    expect(await summarizeHumanNeeded(result)).toBe(result);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      actions: [
        { text: 'Invented command', command: 'deployctl apply --force' },
        actions[0],
      ],
    },
    { actions: [actions[0]] },
    { actions: [...actions, ...actions] },
    { actions: [{ text: 'x'.repeat(401) }, actions[0]] },
    { actions: [{ text: 'Extra field', execute: true }, actions[0]] },
  ])(
    'keeps the original message when output is unsafe or malformed: %j',
    async (output) => {
      fetchMock.mockResolvedValue(response(output));
      expect(await summarizeHumanNeeded(result)).toBe(result);
    },
  );

  it.each([
    () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
    async () => new Response('sensitive upstream response', { status: 503 }),
    async () => new Response('not JSON'),
  ])('settles normally when the summary service fails', async (failure) => {
    fetchMock.mockImplementation(failure);
    expect(await summarizeHumanNeeded(result)).toBe(result);
  });

  it.each(['single chunk', 'multiple chunks'])(
    'cancels an oversized response (%s) and preserves the original handoff',
    async (shape) => {
      const cancel = vi.fn();
      const encoded = new TextEncoder().encode(
        JSON.stringify({
          ignored: 'x'.repeat(70_000),
          choices: [{ message: { content: JSON.stringify({ actions }) } }],
        }),
      );
      let offset = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (offset === encoded.length) {
              controller.close();
              return;
            }
            const end = Math.min(
              encoded.length,
              offset + (shape === 'single chunk' ? encoded.length : 1024),
            );
            controller.enqueue(encoded.subarray(offset, end));
            offset = end;
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      fetchMock.mockResolvedValue(new Response(body));
      expect(await summarizeHumanNeeded(result)).toBe(result);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it('rejects extra choices instead of accepting only the first', async () => {
    const choice = { message: { content: JSON.stringify({ actions }) } };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [choice, choice] })),
    );
    expect(await summarizeHumanNeeded(result)).toBe(result);
  });

  it('cancels an HTTP error body without reading it', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    fetchMock.mockResolvedValue(new Response(body, { status: 503 }));
    expect(await summarizeHumanNeeded(result)).toBe(result);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('fails startup configuration for incomplete or insecure endpoint settings', () => {
    expect(() =>
      handoffSummaryConfig({ AGENT_LCARS_HANDOFF_SUMMARY_MODEL: 'model' }),
    ).toThrow(/all three/);
    for (const url of [
      'http://summary.example.test',
      'https://user:secret@summary.example.test',
    ]) {
      expect(() =>
        handoffSummaryConfig({
          AGENT_LCARS_HANDOFF_SUMMARY_URL: url,
          AGENT_LCARS_HANDOFF_SUMMARY_MODEL: 'model',
          AGENT_LCARS_HANDOFF_SUMMARY_API_KEY: 'test',
        }),
      ).toThrow(/HTTPS/);
    }
  });
});
