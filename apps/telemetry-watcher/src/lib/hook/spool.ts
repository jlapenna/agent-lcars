import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { acquireFileLock, releaseFileLock, touchLock } from './file-lock';

/**
 * Append-only NDJSON spool the hook process writes to and the detached
 * flusher drains (docs/hooks-telemetry-design.md §4.1 step 6). The hook
 * never touches the network itself, so a slow or offline console can only
 * ever delay a doc update, never block the agent.
 *
 * Two files: hooks append to `events.ndjson`; a drain atomically renames it
 * to `events.pending.ndjson`, which only the lock-holding drainer touches.
 * Appends that land during a drain therefore start a fresh live file and
 * are never lost or re-sent, and leftovers from an interrupted drain are
 * processed first next time, preserving order.
 */
export const SPOOL_SUBDIRECTORY = 'spool';
export const SPOOL_FILE = 'events.ndjson';
export const SPOOL_PENDING_FILE = 'events.pending.ndjson';
export const SPOOL_LOCK_FILE = 'events.lock';
export const SPOOL_MAX_BYTES = 5 * 1024 * 1024;
export const SPOOL_LOCK_STALE_MS = 5 * 60_000;

export function spoolPath(stateDirectory: string): string {
  return path.join(stateDirectory, SPOOL_SUBDIRECTORY, SPOOL_FILE);
}

function readLines(filePath: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').filter((line) => line.length > 0);
}

function writeLinesAtomically(
  filePath: string,
  lines: readonly string[],
): void {
  if (lines.length === 0) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Already absent.
    }
    return;
  }
  const temporaryPath = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

/** Appends one event, dropping the oldest lines first when the live file
 * would exceed `maxBytes`. A dropped event only delays a doc update: the
 * next event for that session carries the full summary again. */
export function appendToSpool(
  filePath: string,
  event: unknown,
  maxBytes = SPOOL_MAX_BYTES,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const line = JSON.stringify(event);
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    size = 0;
  }
  if (size + line.length + 1 > maxBytes) {
    const lines = readLines(filePath);
    let total = line.length + 1;
    const kept: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const candidate = lines[i];
      if (total + candidate.length + 1 > maxBytes) break;
      kept.unshift(candidate);
      total += candidate.length + 1;
    }
    writeLinesAtomically(filePath, kept);
  }
  fs.appendFileSync(filePath, `${line}\n`, { mode: 0o600 });
}

export type SpoolSendOutcome = 'sent' | 'drop' | 'retry';

export interface SpoolDrainResult {
  readonly locked: boolean;
  readonly sent: number;
  readonly dropped: number;
  /** Events still waiting (pending leftovers plus the live file). */
  readonly remaining: number;
}

/**
 * Sends spooled events oldest-first, at most `maxEvents` per drain, and
 * stops at the first `retry` so per-session ordering is preserved. One
 * drainer at a time per spool.
 */
export async function drainSpool(
  filePath: string,
  send: (event: unknown) => Promise<SpoolSendOutcome>,
  maxEvents = 20,
  now: () => number = Date.now,
): Promise<SpoolDrainResult> {
  const directory = path.dirname(filePath);
  const lockPath = path.join(directory, SPOOL_LOCK_FILE);
  const pendingPath = path.join(directory, SPOOL_PENDING_FILE);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const locked = await acquireFileLock(lockPath, {
    waitMs: 0,
    staleMs: SPOOL_LOCK_STALE_MS,
    now,
  });
  if (!locked) {
    return {
      locked: true,
      sent: 0,
      dropped: 0,
      remaining: readLines(pendingPath).length + readLines(filePath).length,
    };
  }
  try {
    let sent = 0;
    let dropped = 0;
    let stopped = false;
    for (let round = 0; round < 2 && !stopped; round++) {
      if (!fs.existsSync(pendingPath)) {
        // Take ownership of everything appended so far; hooks keep writing
        // to a fresh live file from here on.
        try {
          fs.renameSync(filePath, pendingPath);
        } catch {
          break;
        }
      }
      const lines = readLines(pendingPath);
      let index = 0;
      while (index < lines.length && sent + dropped < maxEvents) {
        let event: unknown;
        try {
          event = JSON.parse(lines[index]);
        } catch {
          dropped++;
          index++;
          continue;
        }
        const outcome = await send(event);
        touchLock(lockPath);
        if (outcome === 'retry') {
          stopped = true;
          break;
        }
        if (outcome === 'sent') sent++;
        else dropped++;
        index++;
      }
      writeLinesAtomically(pendingPath, lines.slice(index));
      if (index < lines.length) stopped = true;
    }
    return {
      locked: false,
      sent,
      dropped,
      remaining: readLines(pendingPath).length + readLines(filePath).length,
    };
  } finally {
    releaseFileLock(lockPath);
  }
}
