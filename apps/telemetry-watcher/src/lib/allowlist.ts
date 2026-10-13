const GLOB_SPECIAL_CHARS = /[.+^${}()|[\]\\]/g;

/** Compiles a `*`-wildcard glob pattern into an anchored, full-string regex. */
function compileGlob(pattern: string): RegExp {
  const escaped = pattern.replace(GLOB_SPECIAL_CHARS, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

/**
 * Whether a `~/.claude/projects/<dirName>` directory is in scope for
 * discovery, per an allowlist of `*`-wildcard glob patterns matched against
 * the directory's basename (the Claude Code cwd-slug). Runner-mode roots
 * pass `['*']` (see `@agent-lcars/telemetry`'s `runnerWatchRoots`).
 */
export function isAllowedProjectDir(
  dirName: string,
  patterns: string[],
): boolean {
  return patterns.some((pattern) => compileGlob(pattern).test(dirName));
}
