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
 * Rewrites `repo` into the spelling a matching allowlist pattern declares, so
 * a checkout whose `origin` spells the repository with different capitals
 * (`JLapenna/Agent-LCARS`) still records the canonical `owner/name` that
 * Console's owner query and Claimed-but-Idle matching look up (#2583).
 *
 * The most specific matching pattern decides: a literal `owner/name` beats a
 * one-wildcard pattern, which beats `*` + `/*`. A literal segment supplies
 * its own spelling. A `*` segment knows no spelling, so it records the
 * lowercase form: Console reads the canonical spelling and its lowercase,
 * so lowercase is the one spelling every reader finds. A repository whose
 * canonical name has capitals therefore needs a literal allowlist entry.
 * A repository no pattern matches keeps the remote's spelling.
 */
export function canonicalRepoSpelling(
  repo: { owner: string; name: string },
  patterns: readonly string[],
): { owner: string; name: string } {
  const owner = repo.owner.toLowerCase();
  const name = repo.name.toLowerCase();
  let best: { owner: string; name: string; literals: number } | undefined;
  for (const pattern of patterns) {
    const [patternOwner, patternName, ...rest] = pattern.trim().split('/');
    if (!patternOwner || !patternName || rest.length > 0) continue;
    const ownerLiteral = patternOwner !== '*';
    const nameLiteral = patternName !== '*';
    if (ownerLiteral && patternOwner.toLowerCase() !== owner) continue;
    if (nameLiteral && patternName.toLowerCase() !== name) continue;
    const literals = Number(ownerLiteral) + Number(nameLiteral);
    if (best && best.literals >= literals) continue;
    best = {
      owner: ownerLiteral ? patternOwner : owner,
      name: nameLiteral ? patternName : name,
      literals,
    };
  }
  return best ? { owner: best.owner, name: best.name } : repo;
}
