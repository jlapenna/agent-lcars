import { optional } from '@agent-lcars/env';
import { execFile } from 'child_process';

import { canonicalRepoSpelling } from './hook/repo-allowlist';

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
 * Parses `AGENT_TELEMETRY_REPO_ALIASES`: a JSON object keyed by the
 * pre-rename `owner/name` a stale local `origin` remote can still report
 * (GitHub renaming a repo does not rewrite anyone's local remote config),
 * mapping to the current `{owner, name}`. Every deploying fleet has its own
 * repo-rename history (or none at all), so there is no built-in alias here —
 * an unset or empty value means no aliases apply. Throws with a specific
 * reason on malformed input rather than silently ignoring it.
 */
function parseRepoAliasesJson(
  raw: string,
): Record<string, { owner: string; name: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `AGENT_TELEMETRY_REPO_ALIASES is not valid JSON: ${(error as Error).message}`,
      { cause: error },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'AGENT_TELEMETRY_REPO_ALIASES must be a JSON object of {"owner/name": {"owner": string, "name": string}} entries',
    );
  }
  const result: Record<string, { owner: string; name: string }> = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as { owner?: unknown }).owner !== 'string' ||
      typeof (value as { name?: unknown }).name !== 'string'
    ) {
      throw new Error(
        `AGENT_TELEMETRY_REPO_ALIASES["${key}"] must be an object with string "owner" and "name" fields`,
      );
    }
    result[key] = {
      owner: (value as { owner: string }).owner,
      name: (value as { name: string }).name,
    };
  }
  return result;
}

/**
 * Loads the configured rename aliases fresh on every call rather than
 * caching at module scope, so tests can set `AGENT_TELEMETRY_REPO_ALIASES`
 * per case.
 */
function loadRepoAliases(): Record<string, { owner: string; name: string }> {
  const raw = optional('AGENT_TELEMETRY_REPO_ALIASES');
  return raw ? parseRepoAliasesJson(raw) : {};
}

/**
 * Looks up a rename alias for `owner/name`, case-insensitively like GitHub,
 * so a stale remote that also differs in capitals still finds its alias.
 */
function findRepoAlias(
  repoAliases: Record<string, { owner: string; name: string }>,
  repo: { owner: string; name: string },
): { owner: string; name: string } | undefined {
  const key = `${repo.owner}/${repo.name}`;
  if (repoAliases[key]) return repoAliases[key];
  const lowerKey = key.toLowerCase();
  for (const [aliasKey, target] of Object.entries(repoAliases)) {
    if (aliasKey.toLowerCase() === lowerKey) return target;
  }
  return undefined;
}

/**
 * Resolves the `owner/name` of `cwd`'s GitHub `origin` remote, via
 * `git -C <cwd> remote get-url origin`. Fails soft (returns `undefined`)
 * for a non-git dir, a missing `origin` remote, a non-GitHub remote, or any
 * other `git` failure — same shape as `resolveGitBranch`'s error handling,
 * so a resolution hiccup degrades to an unrepoed doc rather than crashing a
 * tick. Async for the same reason as `resolveGitBranch`.
 *
 * The result is the spelling a session is stored under, so it is
 * canonicalized here, at write time (#2583): a configured rename alias wins
 * and is returned verbatim; otherwise, when `watchedRepos` (the hook
 * client's `owner/name` allowlist patterns) matches, the remote's capitals
 * are replaced by the allowlist's canonical spelling (see
 * `canonicalRepoSpelling`); an unwatched repository keeps the remote's own
 * spelling. Only the hook client passes `watchedRepos`: the runner's finalize pass resolves a checkout
 * cloned from its canonical `GITHUB_REPOSITORY`.
 *
 * A malformed `AGENT_TELEMETRY_REPO_ALIASES` is deliberately NOT part of
 * that fail-soft behavior: it is parsed before the fail-soft `try`, so a
 * bad config throws loudly on every call instead of being silently
 * swallowed alongside ordinary git-resolution failures.
 */
export async function resolveGitRepo(
  cwd: string,
  watchedRepos: readonly string[] = [],
): Promise<{ owner: string; name: string } | undefined> {
  const repoAliases = loadRepoAliases();
  try {
    const stdout = await runGit(cwd, ['remote', 'get-url', 'origin']);
    const repo = parseGitHubRemote(stdout.trim());
    if (!repo) return undefined;
    return (
      findRepoAlias(repoAliases, repo) ??
      canonicalRepoSpelling(repo, watchedRepos)
    );
  } catch {
    return undefined;
  }
}
