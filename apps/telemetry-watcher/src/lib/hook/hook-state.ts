import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { type SessionEventKind } from '@agent-lcars/telemetry';

/**
 * Per-session client state under `~/.local/state/agent-lcars/hook-sessions/`
 * (docs/hooks-telemetry-design.md §4.1 step 3).
 */
export const HOOK_SESSIONS_SUBDIRECTORY = 'hook-sessions';

export interface HookSessionState {
  readonly version: 1;
  readonly sessionId: string;
  /** Last `seq` assigned to an event for this session. */
  readonly seq: number;
  /** When an event was last appended to the spool, ISO. */
  readonly lastShippedAt?: string;
  /** When the flusher last got a 2xx for one of this session's events, ISO.
   * Unlike `updatedAt`, this records that the hook path really delivered. */
  readonly lastDeliveredAt?: string;
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
    const lastDeliveredAt = record['lastDeliveredAt'];
    const lastKind = record['lastKind'];
    return {
      version: 1,
      sessionId,
      seq,
      updatedAt,
      ...(typeof lastShippedAt === 'string' && { lastShippedAt }),
      ...(typeof lastDeliveredAt === 'string' && { lastDeliveredAt }),
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

/** Lock file guarding one session's read-modify-write of its state, so two
 * overlapping async hooks never assign the same `seq`. */
export function hookSessionLockPath(
  stateDirectory: string,
  sessionId: string,
): string {
  return path.join(
    hookSessionStateDirectory(stateDirectory),
    `${sessionId}.lock`,
  );
}

/** Records a successful delivery for the session, keeping every other field. */
export function markHookSessionDelivered(
  stateDirectory: string,
  sessionId: string,
  now: string,
): void {
  const state = readHookSessionState(stateDirectory, sessionId);
  writeHookSessionState(stateDirectory, {
    version: 1,
    sessionId,
    seq: state?.seq ?? 0,
    ...(state?.lastShippedAt && { lastShippedAt: state.lastShippedAt }),
    ...(state?.lastKind && { lastKind: state.lastKind }),
    lastDeliveredAt: now,
    updatedAt: now,
  });
}

/**
 * Written by the runner before `runner finalize` (runtime/hook-telemetry-
 * bootstrap.sh). A hook that takes its session lock after the fence exists
 * records nothing, so no late event can follow the authoritative final doc
 * and reopen an ended session.
 */
export const HOOK_FENCE_FILE = 'hook-fence';

export function isHookFenced(stateDirectory: string): boolean {
  return fs.existsSync(path.join(stateDirectory, HOOK_FENCE_FILE));
}
