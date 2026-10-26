import * as path from 'node:path';

/**
 * The hook client's privacy boundary (docs/hooks-telemetry-design.md §4.1
 * step 2). Hooks fire for every project on a workstation; only sessions
 * whose checkout's `origin` resolves to an allowlisted GitHub repository
 * are reduced or shipped. Patterns are `owner/name` with `*` allowed as a
 * whole segment (`jlapenna/*`, `*` + `/agent-lcars`, or a star in both
 * segments for everything), compared case-insensitively like GitHub does.
 */
export function matchesRepoAllowlist(
  repo: { owner: string; name: string },
  patterns: readonly string[],
): boolean {
  const owner = repo.owner.toLowerCase();
  const name = repo.name.toLowerCase();
  for (const pattern of patterns) {
    const [patternOwner, patternName, ...rest] = pattern
      .trim()
      .toLowerCase()
      .split('/');
    if (!patternOwner || !patternName || rest.length > 0) continue;
    const ownerMatches = patternOwner === '*' || patternOwner === owner;
    const nameMatches = patternName === '*' || patternName === name;
    if (ownerMatches && nameMatches) return true;
  }
  return false;
}

/**
 * The privacy boundary for a session that is not inside any git checkout,
 * such as one started in a directory that holds many checkouts (`~/p`).
 * Such a session has no repository to allowlist, so it ships, without a
 * repo, only when its cwd is at or below a configured workspace root. A cwd
 * inside a checkout never reaches this check, so a session started in an
 * unlisted checkout stays private even under a workspace root. The boundary
 * is the cwd: the hook also drops transcript evidence that names an unlisted
 * repository or no repository from a session admitted here.
 */
export function matchesWorkspaceAllowlist(
  cwd: string,
  workspaces: readonly string[],
): boolean {
  if (!path.isAbsolute(cwd)) return false;
  const resolved = path.resolve(cwd);
  return workspaces.some((root) => {
    const relative = path.relative(root, resolved);
    return (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    );
  });
}

/**
 * Rewrites `repo` into the spelling the allowlist declares, so a checkout
 * whose `origin` spells the repository with different capitals
 * (`JLapenna/Agent-LCARS`) still records an `owner/name` that Console's
 * owner query and Claimed-but-Idle matching look up (#2583). Console reads
 * the canonical spelling and its full lowercase form, so the result is
 * always one of those two, never a mix:
 *
 * - a literal `owner/name` entry matching case-insensitively supplies its
 *   own spelling;
 * - otherwise a matching pattern with a `*` segment knows no complete
 *   spelling, so the full lowercase form is recorded. A repository whose
 *   canonical name has capitals therefore needs a literal entry;
 * - a repository no pattern matches keeps the remote's spelling.
 */
export function canonicalRepoSpelling(
  repo: { owner: string; name: string },
  patterns: readonly string[],
): { owner: string; name: string } {
  const owner = repo.owner.toLowerCase();
  const name = repo.name.toLowerCase();
  for (const pattern of patterns) {
    const [patternOwner, patternName, ...rest] = pattern.trim().split('/');
    if (!patternOwner || !patternName || rest.length > 0) continue;
    if (patternOwner === '*' || patternName === '*') continue;
    if (
      patternOwner.toLowerCase() === owner &&
      patternName.toLowerCase() === name
    ) {
      return { owner: patternOwner, name: patternName };
    }
  }
  return matchesRepoAllowlist(repo, patterns) ? { owner, name } : repo;
}
