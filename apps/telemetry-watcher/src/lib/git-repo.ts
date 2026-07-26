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
 * Repo renames this fleet has been through, keyed by the pre-rename
 * `owner/name` a stale local `origin` remote can still report (GitHub
 * renaming a repo does not rewrite anyone's local remote config). Applied
 * after parsing so every `resolveGitRepo` caller gets the current
 * canonical identity even from a checkout nobody's re-pointed yet, rather
 * than every repo-identity comparison site needing its own alias
 * awareness (see e.g. console's `sessionReferencesItemNumber`).
 */
const LEGACY_REPO_ALIASES: Record<string, { owner: string; name: string }> = {
  'supersprinklesracing/members': {
    owner: 'supersprinklesracing',
    name: 'sprinkles',
  },
};

function normalizeRepoAlias(repo: { owner: string; name: string }): {
  owner: string;
  name: string;
} {
  return LEGACY_REPO_ALIASES[`${repo.owner}/${repo.name}`] ?? repo;
}

/**
 * Resolves the `owner/name` of `cwd`'s GitHub `origin` remote, via
 * `git -C <cwd> remote get-url origin`. Fails soft (returns `undefined`)
 * for a non-git dir, a missing `origin` remote, a non-GitHub remote, or any
 * other `git` failure — same shape as `resolveGitBranch`'s error handling,
 * so a resolution hiccup degrades to an unrepoed doc rather than crashing a
 * tick. Async for the same reason as `resolveGitBranch`.
 */
export async function resolveGitRepo(
  cwd: string,
): Promise<{ owner: string; name: string } | undefined> {
  try {
    const stdout = await runGit(cwd, ['remote', 'get-url', 'origin']);
    const repo = parseGitHubRemote(stdout.trim());
    return repo && normalizeRepoAlias(repo);
  } catch {
    return undefined;
  }
}
