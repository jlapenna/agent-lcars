import { execFile } from 'child_process';

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf8' },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * Resolves the current branch of `cwd` via `git -C <cwd>`, at heartbeat
 * time — fresher than the transcript's own `gitBranch` field, which is only
 * as recent as the last transcript write and can lag a manual branch switch.
 * Fails soft (returns `undefined`) for a non-git dir, a detached HEAD, or
 * any other `git` failure, so a resolution hiccup degrades to the
 * transcript-derived branch rather than crashing a tick. Async so a tick
 * with several changed sessions can resolve their branches concurrently
 * instead of blocking Node's single thread on each subprocess in turn.
 */
export async function resolveGitBranch(
  cwd: string,
): Promise<string | undefined> {
  try {
    const stdout = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = stdout.trim();
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}
