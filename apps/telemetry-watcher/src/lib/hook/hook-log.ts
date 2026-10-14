import * as fs from 'node:fs';
import * as path from 'node:path';

export const HOOK_LOG_FILE = 'hook.log';
const ROTATE_BYTES = 1024 * 1024;

/**
 * One line per client invocation under the agent-lcars state directory,
 * rotated once at 1 MB. Records decisions (ignored, unlisted, throttled,
 * spooled, flushed), never titles, prompts, or transcript content, so the
 * log is safe to paste into an issue.
 */
export function appendHookLog(stateDirectory: string, line: string): void {
  try {
    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const filePath = path.join(stateDirectory, HOOK_LOG_FILE);
    try {
      if (fs.statSync(filePath).size > ROTATE_BYTES) {
        fs.renameSync(filePath, `${filePath}.1`);
      }
    } catch {
      // No log yet.
    }
    fs.appendFileSync(filePath, `${line}\n`, { mode: 0o600 });
  } catch {
    // Logging is best effort; the hook must never fail over it.
  }
}
