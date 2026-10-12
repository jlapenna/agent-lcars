import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Codex writes one rollout per thread at
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<session_id>.jsonl`
 * (verified on 0.162.1, 2026-10-10). Hook payloads normally carry that path
 * as `transcript_path`, but the docs allow null, so this finds the file by
 * session id when they do not.
 */
export function findCodexRollout(
  codexHome: string,
  sessionId: string,
  maxDepth = 4,
): string | undefined {
  const suffix = `-${sessionId}.jsonl`;
  const root = path.join(codexHome, 'sessions');
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  let newest: { file: string; mtimeMs: number } | undefined;
  while (stack.length > 0) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (!newest || mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs };
    }
  }
  return newest?.file;
}
