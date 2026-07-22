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
export function isProcessAliveForCwd(cwd: string, procRoot = '/proc'): boolean {
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
        return true;
      }
    } catch {
      // Process exited mid-scan, or we lack permission to read it — skip.
      continue;
    }
  }

  return false;
}
