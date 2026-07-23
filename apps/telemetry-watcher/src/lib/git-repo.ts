import { execFileSync } from 'child_process';

/**
 * Parses `owner/name` out of a GitHub `origin` remote URL, in any form
 * `git remote get-url` commonly reports:
 *  - SCP-like SSH: `git@github.com:owner/name.git` (or without `.git`)
 *  - Full SSH URL: `ssh://git@github.com/owner/name.git` (or without `.git`)
 *  - HTTPS: `https://github.com/owner/name.git` or `.../owner/name`
 *    (tolerating an optional `user@` prefix)
 * Returns `undefined` for anything else (e.g. a non-GitHub host), so a
 * caller never has to distinguish "not GitHub" from "couldn't parse".
 */
function parseGitHubRemote(
  remoteUrl: string,
): { owner: string; name: string } | undefined {
  const scpMatch = remoteUrl.match(
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (scpMatch) {
    return { owner: scpMatch[1], name: scpMatch[2] };
  }
  const sshUrlMatch = remoteUrl.match(
    /^ssh:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (sshUrlMatch) {
    return { owner: sshUrlMatch[1], name: sshUrlMatch[2] };
  }
  const httpsMatch = remoteUrl.match(
    /^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], name: httpsMatch[2] };
  }
  return undefined;
}

/**
 * Resolves the `owner/name` of `cwd`'s GitHub `origin` remote, via
 * `git -C <cwd> remote get-url origin`. Fails soft (returns `undefined`)
 * for a non-git dir, a missing `origin` remote, a non-GitHub remote, or any
 * other `git` failure — same shape as `resolveGitBranch`'s error handling,
 * so a resolution hiccup degrades to an unrepoed doc rather than crashing a
 * tick.
 */
export function resolveGitRepo(
  cwd: string,
): { owner: string; name: string } | undefined {
  try {
    const remoteUrl = execFileSync(
      'git',
      ['-C', cwd, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return parseGitHubRemote(remoteUrl);
  } catch {
    return undefined;
  }
}
