import * as fs from 'node:fs';

/**
 * Small `O_EXCL` lock file shared by the spool drain and the per-session
 * sequence assignment. A lock older than `staleMs` is treated as abandoned
 * (a hook process killed mid-write must never wedge its session), and the
 * holder refreshes its mtime with {@link touchLock} during long work so a
 * live holder is never mistaken for a stale one.
 */
export interface FileLockOptions {
  /** How long to keep retrying before giving up. */
  readonly waitMs?: number;
  /** Age after which a lock is considered abandoned. */
  readonly staleMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function tryCreate(lockPath: string): boolean {
  try {
    fs.writeFileSync(lockPath, String(process.pid), {
      flag: 'wx',
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function removeIfStale(lockPath: string, now: number, staleMs: number): void {
  try {
    if (now - fs.statSync(lockPath).mtimeMs > staleMs) fs.unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

/** Acquires the lock, retrying until `waitMs`; returns false when it could
 * not be taken in time. */
export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions = {},
): Promise<boolean> {
  const waitMs = options.waitMs ?? 2_000;
  const staleMs = options.staleMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + waitMs;
  for (;;) {
    if (tryCreate(lockPath)) return true;
    removeIfStale(lockPath, now(), staleMs);
    if (tryCreate(lockPath)) return true;
    if (now() >= deadline) return false;
    await sleep(25);
  }
}

export function touchLock(lockPath: string): void {
  try {
    const time = new Date();
    fs.utimesSync(lockPath, time, time);
  } catch {
    // Lost the lock to a stale sweep; the next touch or release notices.
  }
}

export function releaseFileLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already removed as stale by another process.
  }
}
