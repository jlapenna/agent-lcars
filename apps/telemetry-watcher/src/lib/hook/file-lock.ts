import { randomUUID } from 'node:crypto';
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

/** True when `pid` names no process on this host. Locks live in the host's
 * own state directory, so the recorded pid is local. */
function holderIsGone(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Removes a lock whose holder has exited or that is older than `staleMs`.
 * Agent runtimes kill async hooks when they exit (`claude -p` does so right
 * before its SessionEnd hook), and that hook's short budget cannot wait out
 * `staleMs`.
 *
 * The lock is renamed aside before it is removed, so only the file that was
 * judged stale is removed. If the holder released it and another process
 * created a new lock in between (possibly reusing the inode number), the
 * moved file no longer matches what was read and is linked back. */
function removeIfStale(lockPath: string, now: number, staleMs: number): void {
  let before: fs.Stats;
  let holder: string;
  try {
    before = fs.statSync(lockPath);
    holder = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return; // Already gone.
  }
  if (now - before.mtimeMs <= staleMs && !holderIsGone(Number(holder))) return;
  const aside = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, aside);
  } catch {
    return; // Another waiter took it first.
  }
  try {
    const moved = fs.statSync(aside);
    const same =
      moved.ino === before.ino &&
      moved.mtimeMs === before.mtimeMs &&
      fs.readFileSync(aside, 'utf8') === holder;
    if (!same) {
      // Fails only if yet another lock was created meanwhile; that one wins.
      fs.linkSync(aside, lockPath);
    }
  } catch {
    // Restored by another waiter, or replaced; nothing left to undo.
  } finally {
    try {
      fs.unlinkSync(aside);
    } catch {
      // Already removed.
    }
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
