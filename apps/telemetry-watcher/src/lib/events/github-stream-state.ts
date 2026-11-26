import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { parseAgentEventKey } from '@agent-lcars/work';

export interface GithubStreamCheckpoints {
  get(key: string): string | undefined;
  set(key: string, at: string): void;
}

/** Runtime state only, separate from subscriptions. A saved successful read
 * watermark avoids replaying an entire review history after a host restart
 * when it exceeds the router's bounded event-ID memory. A corrupt/unreadable
 * file fails visibly; it does not fabricate an empty successful checkpoint. */
export function fileGithubStreamCheckpoints(
  directory: string,
): GithubStreamCheckpoints {
  const file = path.join(directory, 'github-stream-checkpoints.json');
  let entries: Map<string, string> | undefined;
  const load = () => {
    if (entries) return entries;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return (entries = new Map());
      throw new Error('Cannot read GitHub stream checkpoints', {
        cause: error,
      });
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data))
      throw new Error('Invalid GitHub stream checkpoints');
    const pairs = Object.entries(data);
    if (
      pairs.length > 1024 ||
      pairs.some(([key, at]) => {
        const parsed = parseAgentEventKey(key);
        return (
          !parsed.ok ||
          parsed.value.source !== 'github:pr' ||
          typeof at !== 'string' ||
          !Number.isFinite(Date.parse(at))
        );
      })
    )
      throw new Error('Invalid GitHub stream checkpoints');
    return (entries = new Map(pairs as [string, string][]));
  };
  return {
    get: (key) => load().get(key),
    set: (key, at) => {
      const next = new Map(load());
      next.set(key, at);
      if (next.size > 1024) {
        const oldest = [...next].sort(
          (a, b) => Date.parse(a[1]) - Date.parse(b[1]),
        );
        for (const [id] of oldest.slice(0, next.size - 1024)) next.delete(id);
      }
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(
        directory,
        `.github-stream-checkpoints.${randomBytes(8).toString('hex')}.tmp`,
      );
      try {
        writeFileSync(
          temporary,
          `${JSON.stringify(Object.fromEntries(next))}\n`,
          { mode: 0o600 },
        );
        renameSync(temporary, file);
        entries = next;
      } catch (error) {
        try {
          unlinkSync(temporary);
        } catch {
          /* absent */
        }
        throw error;
      }
    },
  };
}
