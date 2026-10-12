import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Append-only NDJSON spool the hook process writes to and the detached
 * flusher drains (docs/hooks-telemetry-design.md §4.1 step 6). The hook
 * never touches the network itself, so a slow or offline console can only
 * ever delay a doc update, never block the agent.
 */
export const SPOOL_SUBDIRECTORY = 'spool';
export const SPOOL_FILE = 'events.ndjson';
export const SPOOL_LOCK_FILE = 'events.lock';
export const SPOOL_MAX_BYTES = 5 * 1024 * 1024;
const LOCK_STALE_MS = 60_000;

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
  const temporaryPath = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  fs.writeFileSync(temporaryPath, body, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

/** Appends one event, dropping the oldest lines first when the file would
 * exceed `maxBytes`. A dropped event only delays a doc update: the next
 * event for that session carries the full summary again. */
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
  readonly remaining: number;
}

function acquireLock(lockPath: string, now: number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), {
        flag: 'wx',
        mode: 0o600,
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      try {
        const age = now - fs.statSync(lockPath).mtimeMs;
        if (age < LOCK_STALE_MS) return false;
        fs.unlinkSync(lockPath);
      } catch {
        return false;
      }
    }
  }
  return false;
}

/**
 * Sends spooled events oldest-first, at most `maxEvents` per drain, and
 * stops at the first `retry` so ordering per session is preserved. One
 * flusher at a time per spool via an `O_EXCL` lock file that is treated as
 * stale after a minute (a flusher killed mid-drain must not wedge the spool).
 */
export async function drainSpool(
  filePath: string,
  send: (event: unknown) => Promise<SpoolSendOutcome>,
  maxEvents = 20,
  now: () => number = Date.now,
): Promise<SpoolDrainResult> {
  const lockPath = path.join(path.dirname(filePath), SPOOL_LOCK_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (!acquireLock(lockPath, now())) {
    return {
      locked: true,
      sent: 0,
      dropped: 0,
      remaining: readLines(filePath).length,
    };
  }
  try {
    const lines = readLines(filePath);
    let sent = 0;
    let dropped = 0;
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
      if (outcome === 'retry') break;
      if (outcome === 'sent') sent++;
      else dropped++;
      index++;
    }
    // Re-read so events appended during the drain are kept, then remove
    // exactly the prefix this drain consumed.
    const current = readLines(filePath);
    const consumed = lines.slice(0, index);
    const remaining = current.slice(
      consumed.every((line, i) => current[i] === line) ? consumed.length : 0,
    );
    writeLinesAtomically(filePath, remaining);
    return { locked: false, sent, dropped, remaining: remaining.length };
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Lock already removed as stale by a later flusher.
    }
  }
}
