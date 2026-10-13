import { type SessionEventKind } from '@agent-lcars/telemetry';

/** Runtimes whose hooks the `lcars hook <runtime>` client understands. */
export const HOOK_RUNTIMES = ['claude', 'codex', 'opencode'] as const;
export type HookRuntime = (typeof HOOK_RUNTIMES)[number];

export function isHookRuntime(value: unknown): value is HookRuntime {
  return HOOK_RUNTIMES.includes(value as HookRuntime);
}

/**
 * The subset of a runtime hook's stdin JSON the client acts on. Claude Code
 * (https://code.claude.com/docs/en/hooks) and Codex
 * (https://learn.chatgpt.com/docs/hooks) share the field names; both were
 * verified on 2026-10-10 (Claude Code 2.1.296 in print mode, Codex 0.162.1
 * under `codex exec`) to fire `SessionStart`, `UserPromptSubmit`,
 * `PostToolUse`, `Stop`, and `SessionEnd` with `session_id`, `cwd`, and
 * `transcript_path`. `prompt`, `tool_input`, `tool_response`, and
 * `last_assistant_message` are deliberately not read: the client ships
 * summaries only, never bodies.
 */
export interface HookPayload {
  readonly hookEventName: string;
  readonly sessionId: string;
  /** Claude always sets it; Codex documents it as nullable. */
  readonly transcriptPath?: string;
  readonly cwd?: string;
  /** `SessionStart.source`: startup | resume | clear | compact | fork. */
  readonly source?: string;
  /** `SessionEnd.reason`. */
  readonly reason?: string;
  /** Codex puts the model on every payload; Claude only sometimes. */
  readonly model?: string;
  /** Present when the hook fired inside a subagent; such payloads are
   * skipped (the parent transcript already carries the sidechain). */
  readonly isSubagent: boolean;
}

/** Hook event name → session event kind. Events not listed here
 * (Notification, PreCompact, ...) are accepted and ignored. Codex's
 * `Interrupt` means the turn stopped, so it maps like `Stop`. */
export const HOOK_EVENT_KINDS: Readonly<Record<string, SessionEventKind>> = {
  SessionStart: 'start',
  UserPromptSubmit: 'prompt',
  PostToolUse: 'tool',
  Stop: 'stop',
  Interrupt: 'stop',
  SessionEnd: 'end',
};

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function parseHookPayload(raw: string): HookPayload | undefined {
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
  const model = optionalString(record['model']);
  return {
    hookEventName,
    sessionId,
    ...(transcriptPath && { transcriptPath }),
    ...(cwd && { cwd }),
    ...(source && { source }),
    ...(reason && { reason }),
    ...(model && { model }),
    isSubagent: optionalString(record['agent_id']) !== undefined,
  };
}
