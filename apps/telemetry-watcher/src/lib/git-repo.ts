import { optional } from '@agent-lcars/env';
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
 * Parses `AGENT_TELEMETRY_REPO_ALIASES`: a JSON object keyed by the
 * pre-rename `owner/name` a stale local `origin` remote can still report
 * (GitHub renaming a repo does not rewrite anyone's local remote config),
 * mapping to the current `{owner, name}`. Every deploying fleet has its own
 * repo-rename history (or none at all), so there is no built-in alias here —
 * an unset or empty value means no aliases apply. Throws with a specific
 * reason on malformed input rather than silently ignoring it, matching
 * `config.ts`'s `AGENT_TELEMETRY_WATCH_ROOTS` convention.
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
 * Loads the configured rename aliases fresh on every call (like
 * `config.ts`'s env-driven fields) rather than caching at module scope, so
 * tests can set `AGENT_TELEMETRY_REPO_ALIASES` per case and a long-lived
 * daemon process picks up an env change on next resolution without a
 * restart-triggering code path of its own.
 */
function loadRepoAliases(): Record<string, { owner: string; name: string }> {
  const raw = optional('AGENT_TELEMETRY_REPO_ALIASES');
  return raw ? parseRepoAliasesJson(raw) : {};
}

/**
 * Resolves the `owner/name` of `cwd`'s GitHub `origin` remote, via
 * `git -C <cwd> remote get-url origin`. Fails soft (returns `undefined`)
 * for a non-git dir, a missing `origin` remote, a non-GitHub remote, or any
 * other `git` failure — same shape as `resolveGitBranch`'s error handling,
 * so a resolution hiccup degrades to an unrepoed doc rather than crashing a
 * tick. Async for the same reason as `resolveGitBranch`.
 *
 * A malformed `AGENT_TELEMETRY_REPO_ALIASES` is deliberately NOT part of
 * that fail-soft behavior: it is parsed before the fail-soft `try`, so a
 * bad config throws loudly on every call instead of being silently
 * swallowed alongside ordinary git-resolution failures.
 */
export async function resolveGitRepo(
  cwd: string,
): Promise<{ owner: string; name: string } | undefined> {
  const repoAliases = loadRepoAliases();
  try {
    const stdout = await runGit(cwd, ['remote', 'get-url', 'origin']);
    const repo = parseGitHubRemote(stdout.trim());
    return repo && (repoAliases[`${repo.owner}/${repo.name}`] ?? repo);
  } catch {
    return undefined;
  }
}
