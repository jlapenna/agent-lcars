/**
 * The watcher only ever ships CLI telemetry for project dirs matching this
 * allowlist — interactive transcripts can contain other projects' data, so
 * scope creep here is a privacy incident, not just a bug. See PRD #2112
 * amendment 2026-07-10, decision 3.
 */
export const DEFAULT_PROJECT_DIR_ALLOWLIST = ['-home-jlapenna-p-members*'];

const GLOB_SPECIAL_CHARS = /[.+^${}()|[\]\\]/g;

/** Compiles a `*`-wildcard glob pattern into an anchored, full-string regex. */
function compileGlob(pattern: string): RegExp {
  const escaped = pattern.replace(GLOB_SPECIAL_CHARS, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

/**
 * Whether a `~/.claude/projects/<dirName>` directory is in scope for
 * watching, per the configured allowlist of `*`-wildcard glob patterns
 * matched against the directory's basename (the Claude Code cwd-slug).
 */
export function isAllowedProjectDir(
  dirName: string,
  patterns: string[] = DEFAULT_PROJECT_DIR_ALLOWLIST,
): boolean {
  return patterns.some((pattern) => compileGlob(pattern).test(dirName));
}
