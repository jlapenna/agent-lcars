import * as fs from 'fs';
import * as path from 'path';

/**
 * Whether any running process currently has `cwd` as its working directory,
 * per `/proc/<pid>/cwd` (Linux only — the daemon ships as a Linux container
 * image). Used to distinguish a genuinely `ended` session (process exited)
 * from one that's merely `idle`. Fails soft: an unreadable `/proc` (e.g. a
 * sandboxed non-Linux dev environment) yields `false` rather than a throw,
 * so at worst liveness degrades to `ended` instead of crashing the daemon.
 */
const PROCESS_START_TOLERANCE_MS = 2 * 60 * 1000;
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

export function isProcessAliveForCwd(
  cwd: string,
  procRoot = '/proc',
  sessionId?: string,
  sessionStartedAt?: string,
): boolean {
  let pids: string[];
  try {
    pids = fs.readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return false;
  }

  for (const pid of pids) {
    try {
      const procCwd = fs.readlinkSync(path.join(procRoot, pid, 'cwd'));
      // Claude can record a nested tool cwd while its long-lived parent CLI
      // process remains at the repository root. Treat that ancestor process
      // as owning the session too, but never let filesystem root match every
      // session on the host.
      const procFsRoot = path.parse(procCwd).root;
      if (
        procCwd === cwd ||
        (procCwd !== procFsRoot && cwd.startsWith(`${procCwd}${path.sep}`))
      ) {
        // Resumed Codex processes carry the authoritative session id in
        // argv. This prevents one CLI at a shared repo cwd from making every
        // historical transcript for that repo appear alive.
        if (sessionId) {
          const cmdline = fs
            .readFileSync(path.join(procRoot, pid, 'cmdline'), 'utf8')
            .split('\0');
          if (cmdline.includes(sessionId)) return true;
        }

        // Fresh, non-resumed Codex/Claude invocations do not put their new
        // session id in argv. Correlate their Linux process start time with
        // the transcript start time instead (the gap is normally seconds).
        if (sessionStartedAt) {
          const bootTimeLine = fs
            .readFileSync(path.join(procRoot, 'stat'), 'utf8')
            .split('\n')
            .find((line) => line.startsWith('btime '));
          const processStat = fs.readFileSync(
            path.join(procRoot, pid, 'stat'),
            'utf8',
          );
          const fieldsAfterComm = processStat
            .slice(processStat.lastIndexOf(')') + 2)
            .trim()
            .split(/\s+/);
          const bootTimeSeconds = Number(bootTimeLine?.split(/\s+/)[1]);
          const startTicks = Number(fieldsAfterComm[19]);
          const sessionStartMs = Date.parse(sessionStartedAt);
          const processStartMs =
            (bootTimeSeconds + startTicks / LINUX_CLOCK_TICKS_PER_SECOND) *
            1000;
          if (
            Number.isFinite(processStartMs) &&
            Number.isFinite(sessionStartMs) &&
            Math.abs(processStartMs - sessionStartMs) <=
              PROCESS_START_TOLERANCE_MS
          ) {
            return true;
          }
        }

        // Preserve the original helper contract for callers/tests that only
        // ask about a cwd and have no session identity available.
        if (!sessionId && !sessionStartedAt) return true;
      }
    } catch {
      // Process exited mid-scan, or we lack permission to read it — skip.
      continue;
    }
  }

  return false;
}
