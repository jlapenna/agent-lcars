import { describe, expect, it } from 'vitest';

import { parseHookPayload } from './hook-payload';

describe('parseHookPayload', () => {
  it('reads the shared fields from a Claude Code payload and ignores bodies', () => {
    const payload = parseHookPayload(
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'abc',
        transcript_path: '/t.jsonl',
        cwd: '/w',
        permission_mode: 'bypassPermissions',
        prompt: 'secret body',
      }),
    );
    expect(payload).toEqual({
      hookEventName: 'UserPromptSubmit',
      sessionId: 'abc',
      transcriptPath: '/t.jsonl',
      cwd: '/w',
      isSubagent: false,
    });
    expect(JSON.stringify(payload)).not.toContain('secret body');
  });

  it('reads a Codex payload with model and a null transcript path', () => {
    const payload = parseHookPayload(
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: '01a1284f',
        transcript_path: null,
        cwd: '/w',
        model: 'gpt-6.1-sol',
        turn_id: 't1',
        last_assistant_message: 'body',
      }),
    );
    expect(payload).toMatchObject({
      hookEventName: 'Stop',
      sessionId: '01a1284f',
      model: 'gpt-6.1-sol',
    });
    expect(payload?.transcriptPath).toBeUndefined();
  });

  it('flags subagent payloads and rejects malformed input', () => {
    expect(
      parseHookPayload(
        JSON.stringify({
          hook_event_name: 'Stop',
          session_id: 's',
          agent_id: 'a',
        }),
      )?.isSubagent,
    ).toBe(true);
    expect(parseHookPayload('')).toBeUndefined();
    expect(parseHookPayload('[]')).toBeUndefined();
    expect(
      parseHookPayload(JSON.stringify({ session_id: 's' })),
    ).toBeUndefined();
  });
});
