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

/** A takeover guard left by a waiter killed mid-takeover. Taking over is a
 * few file operations, so anything this old is abandoned. */
const TAKEOVER_STALE_MS = 5_000;

/** True when the lock file still holds what was read: same file, untouched
 * since, same holder. */
function unchanged(
  lockPath: string,
  before: fs.Stats,
  holder: string,
): boolean {
  try {
    const now = fs.statSync(lockPath);
    return (
      now.ino === before.ino &&
      now.mtimeMs === before.mtimeMs &&
      fs.readFileSync(lockPath, 'utf8') === holder
    );
  } catch {
    return false;
  }
}

/** Removes a lock whose holder has exited or that is older than `staleMs`.
 * Agent runtimes kill async hooks when they exit (`claude -p` does so right
 * before its SessionEnd hook), and that hook's short budget cannot wait out
 * `staleMs`.
 *
 * Takeovers are serialized by an `O_EXCL` guard file, and the lock is read
 * again inside it, so concurrent waiters never remove a lock another waiter
 * has just taken. A lock whose holder has exited cannot be released, so
 * under the guard it can only disappear here. */
function removeIfStale(lockPath: string, now: number, staleMs: number): void {
  const guard = `${lockPath}.takeover`;
  if (!tryCreate(guard)) {
    try {
      if (now - fs.statSync(guard).mtimeMs > TAKEOVER_STALE_MS) {
        fs.unlinkSync(guard);
      }
    } catch {
      // Released meanwhile.
    }
    return;
  }
  try {
    const before = fs.statSync(lockPath);
    const holder = fs.readFileSync(lockPath, 'utf8');
    const stale =
      now - before.mtimeMs > staleMs || holderIsGone(Number(holder));
    if (stale && unchanged(lockPath, before, holder)) fs.unlinkSync(lockPath);
  } catch {
    // Already gone.
  } finally {
    try {
      fs.unlinkSync(guard);
    } catch {
      // Cleared as abandoned by another waiter.
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
