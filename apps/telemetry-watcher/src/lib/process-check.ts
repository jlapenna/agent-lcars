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

export interface ProcCwdEntry {
  pid: string;
  cwd: string;
}

/**
 * Every daemon tick shares one `scanProcCwds()` array across its sessions.
 * Cache the host boot time against that array so start-time correlation reads
 * `/proc/stat` once per scan rather than once for every matching process.
 * Weak keys let an old tick's snapshot disappear without lifecycle cleanup.
 */
const bootTimeByProcessScan = new WeakMap<
  readonly ProcCwdEntry[],
  number | undefined
>();

function bootTimeSeconds(
  procRoot: string,
  processes: readonly ProcCwdEntry[],
): number | undefined {
  if (bootTimeByProcessScan.has(processes)) {
    return bootTimeByProcessScan.get(processes);
  }
  let value: number | undefined;
  try {
    const bootTimeLine = fs
      .readFileSync(path.join(procRoot, 'stat'), 'utf8')
      .split('\n')
      .find((line) => line.startsWith('btime '));
    const parsed = Number(bootTimeLine?.split(/\s+/)[1]);
    value = Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    // The process scan itself remains useful even if `/proc/stat` is absent.
  }
  bootTimeByProcessScan.set(processes, value);
  return value;
}

/**
 * Scans `/proc` exactly once, returning every process's `{pid, cwd}`. A
 * daemon tick tracks many sessions at once, and each one used to trigger its
 * own full `readdirSync('/proc')` + per-pid `readlinkSync` — O(sessions ×
 * host processes) system calls every heartbeat. Callers checking liveness
 * for a whole batch of sessions should scan once via this function and pass
 * the result to every `isProcessAliveForCwd` call instead.
 */
export function scanProcCwds(procRoot = '/proc'): ProcCwdEntry[] {
  let pids: string[];
  try {
    pids = fs.readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return [];
  }

  const entries: ProcCwdEntry[] = [];
  for (const pid of pids) {
    try {
      entries.push({
        pid,
        cwd: fs.readlinkSync(path.join(procRoot, pid, 'cwd')),
      });
    } catch {
      // Process exited mid-scan, or we lack permission to read it — skip.
      continue;
    }
  }
  return entries;
}

export function isProcessAliveForCwd(
  cwd: string,
  procRoot = '/proc',
  sessionId?: string,
  sessionStartedAt?: string,
  agent?: string,
  processes: ProcCwdEntry[] = scanProcCwds(procRoot),
): boolean {
  for (const { pid, cwd: procCwd } of processes) {
    try {
      // Claude can record a nested tool cwd while its long-lived parent CLI
      // process remains at the repository root. Treat that ancestor process
      // as owning the session too, but never let filesystem root match every
      // session on the host.
      const procFsRoot = path.parse(procCwd).root;
      if (
        procCwd === cwd ||
        (procCwd !== procFsRoot && cwd.startsWith(`${procCwd}${path.sep}`))
      ) {
        // Preserve the original helper contract for callers/tests that only
        // ask about a cwd and have no session identity available.
        if (!sessionId && !sessionStartedAt) return true;

        const cmdline = fs
          .readFileSync(path.join(procRoot, pid, 'cmdline'), 'utf8')
          .split('\0')
          .filter(Boolean);
        const executable = path.basename(cmdline[0] ?? '');
        if (
          (agent === 'codex' && executable !== 'codex') ||
          (agent === 'claude-code' && executable !== 'claude')
        ) {
          continue;
        }

        // Resumed Codex processes carry the authoritative session id in
        // argv. This prevents one CLI at a shared repo cwd from making every
        // historical transcript for that repo appear alive.
        if (sessionId) {
          if (cmdline.includes(sessionId)) return true;
          // A resumed Codex invocation names its authoritative session in
          // argv. Never let start-time correlation attach that process to a
          // different transcript that happened to begin around the same time.
          if (agent === 'codex' && cmdline.includes('resume')) continue;
        }

        // Fresh, non-resumed Codex/Claude invocations do not put their new
        // session id in argv. Correlate their Linux process start time with
        // the transcript start time instead (the gap is normally seconds).
        if (sessionStartedAt) {
          const processStat = fs.readFileSync(
            path.join(procRoot, pid, 'stat'),
            'utf8',
          );
          const fieldsAfterComm = processStat
            .slice(processStat.lastIndexOf(')') + 2)
            .trim()
            .split(/\s+/);
          const bootTime = bootTimeSeconds(procRoot, processes);
          if (bootTime === undefined) continue;
          const startTicks = Number(fieldsAfterComm[19]);
          const sessionStartMs = Date.parse(sessionStartedAt);
          const processStartMs =
            (bootTime + startTicks / LINUX_CLOCK_TICKS_PER_SECOND) * 1000;
          if (
            Number.isFinite(processStartMs) &&
            Number.isFinite(sessionStartMs) &&
            Math.abs(processStartMs - sessionStartMs) <=
              PROCESS_START_TOLERANCE_MS
          ) {
            return true;
          }
        }
      }
    } catch {
      // Process exited mid-scan, or we lack permission to read it — skip.
      continue;
    }
  }

  return false;
}
