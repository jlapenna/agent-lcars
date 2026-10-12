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
