import { execFileSync } from 'child_process';

/**
 * Resolves the current branch of `cwd` via `git -C <cwd>`, at heartbeat
 * time — fresher than the transcript's own `gitBranch` field, which is only
 * as recent as the last transcript write and can lag a manual branch switch.
 * Fails soft (returns `undefined`) for a non-git dir, a detached HEAD, or
 * any other `git` failure, so a resolution hiccup degrades to the
 * transcript-derived branch rather than crashing a tick.
 */
export function resolveGitBranch(cwd: string): string | undefined {
  try {
    const branch = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}
