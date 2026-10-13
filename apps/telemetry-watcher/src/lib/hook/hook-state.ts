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
  /** When the flusher last got a 2xx for one of this session's events, ISO.
   * This, not `updatedAt`, is what tells the daemon the hook path is really
   * delivering for the session. */
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

/** How recently a hook must have reported a session for the polling daemon
 * to leave it alone (docs/hooks-telemetry-design.md §4.1 step 8). Twice the
 * console's 5-minute display tolerance, so a hook client that dies hands
 * the session back to the daemon before the console shows it as ended. */
export const HOOK_REPORTED_WINDOW_MS = 10 * 60 * 1000;

/** Whether a hook client reported this session within the window. The
 * daemon uses this to skip sessions the hook path already covers, so the
 * two writers never race on one doc during the rollout. */
export function isHookReported(
  stateDirectory: string,
  sessionId: string,
  now: string,
  windowMs = HOOK_REPORTED_WINDOW_MS,
): boolean {
  const state = readHookSessionState(stateDirectory, sessionId);
  if (!state?.lastDeliveredAt) return false;
  const age = Date.parse(now) - Date.parse(state.lastDeliveredAt);
  return Number.isFinite(age) && age >= 0 && age <= windowMs;
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
