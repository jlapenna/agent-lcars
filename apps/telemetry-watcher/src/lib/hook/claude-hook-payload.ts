import { type SessionEventKind } from '@agent-lcars/telemetry';

/**
 * The subset of a Claude Code hook's stdin JSON the `lcars hook claude`
 * client acts on (https://code.claude.com/docs/en/hooks, "common input
 * fields"). Verified against Claude Code 2.1.296 in print mode on
 * 2026-10-10: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`,
 * and `SessionEnd` all fire and all carry `session_id`, `cwd`, and
 * `transcript_path`. `prompt`, `tool_input`, `tool_response`, and
 * `last_assistant_message` are deliberately not read: the client ships
 * summaries only, never bodies.
 */
export interface ClaudeHookPayload {
  readonly hookEventName: string;
  readonly sessionId: string;
  readonly transcriptPath?: string;
  readonly cwd?: string;
  /** `SessionStart.source`: startup | resume | clear | compact | fork. */
  readonly source?: string;
  /** `SessionEnd.reason`. */
  readonly reason?: string;
  /** Present when the hook fired inside a subagent; such payloads are
   * skipped (the parent transcript already carries the sidechain). */
  readonly isSubagent: boolean;
}

/** Claude hook event name → session event kind. Events not listed here
 * (Notification, PreCompact, ...) are accepted and ignored. */
export const CLAUDE_HOOK_EVENT_KINDS: Readonly<
  Record<string, SessionEventKind>
> = {
  SessionStart: 'start',
  UserPromptSubmit: 'prompt',
  PostToolUse: 'tool',
  Stop: 'stop',
  SessionEnd: 'end',
};

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function parseClaudeHookPayload(
  raw: string,
): ClaudeHookPayload | undefined {
  if (raw.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const hookEventName = optionalString(record['hook_event_name']);
  const sessionId = optionalString(record['session_id']);
  if (!hookEventName || !sessionId) return undefined;
  const transcriptPath = optionalString(record['transcript_path']);
  const cwd = optionalString(record['cwd']);
  const source = optionalString(record['source']);
  const reason = optionalString(record['reason']);
  return {
    hookEventName,
    sessionId,
    ...(transcriptPath && { transcriptPath }),
    ...(cwd && { cwd }),
    ...(source && { source }),
    ...(reason && { reason }),
    isSubagent: optionalString(record['agent_id']) !== undefined,
  };
}
