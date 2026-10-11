import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { type SessionEventKind } from '@agent-lcars/telemetry';

/**
 * Per-session client state under `~/.local/state/agent-lcars/hook-sessions/`
 * (docs/hooks-telemetry-design.md §4.1 step 3). The file doubles as the
 * coexistence marker the polling daemon checks during the rollout: a
 * fresh marker means "a hook is reporting this session, skip it".
 */
export const HOOK_SESSIONS_SUBDIRECTORY = 'hook-sessions';

export interface HookSessionState {
  readonly version: 1;
  readonly sessionId: string;
  /** Last `seq` assigned to an event for this session. */
  readonly seq: number;
  /** When an event was last appended to the spool, ISO. */
  readonly lastShippedAt?: string;
  readonly lastKind?: SessionEventKind;
  readonly updatedAt: string;
}

/** `PostToolUse` fires per tool call; a session summary rarely changes in
 * a meaningful way faster than this. Lifecycle kinds always ship. */
export const TOOL_EVENT_THROTTLE_MS = 15_000;

export function hookSessionStateDirectory(stateDirectory: string): string {
  return path.join(stateDirectory, HOOK_SESSIONS_SUBDIRECTORY);
}

export function readHookSessionState(
  stateDirectory: string,
  sessionId: string,
): HookSessionState | undefined {
  const filePath = path.join(
    hookSessionStateDirectory(stateDirectory),
    `${sessionId}.json`,
  );
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record['version'] !== 1 || record['sessionId'] !== sessionId) {
      return undefined;
    }
    const seq = record['seq'];
    const updatedAt = record['updatedAt'];
    if (
      typeof seq !== 'number' ||
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      typeof updatedAt !== 'string'
    ) {
      return undefined;
    }
    const lastShippedAt = record['lastShippedAt'];
    const lastKind = record['lastKind'];
    return {
      version: 1,
      sessionId,
      seq,
      updatedAt,
      ...(typeof lastShippedAt === 'string' && { lastShippedAt }),
      ...(typeof lastKind === 'string' && {
        lastKind: lastKind as SessionEventKind,
      }),
    };
  } catch {
    return undefined;
  }
}

/** Crash-safe rename-into-place, mode 0700 directory, like the title CLI. */
export function writeHookSessionState(
  stateDirectory: string,
  state: HookSessionState,
): void {
  const directory = hookSessionStateDirectory(stateDirectory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const finalPath = path.join(directory, `${state.sessionId}.json`);
  const temporaryPath = path.join(
    directory,
    `.${state.sessionId}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, finalPath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Already gone or never created.
    }
    throw error;
  }
}

/** Whether this event kind should be appended now, given the last ship. */
export function shouldShipEvent(
  kind: SessionEventKind,
  state: HookSessionState | undefined,
  now: string,
  throttleMs = TOOL_EVENT_THROTTLE_MS,
): boolean {
  if (kind !== 'tool') return true;
  if (!state?.lastShippedAt) return true;
  const elapsed = Date.parse(now) - Date.parse(state.lastShippedAt);
  return !Number.isFinite(elapsed) || elapsed >= throttleMs;
}
