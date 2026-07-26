import { SessionSummary } from '@agent-lcars/telemetry';

/**
 * Stamps `summary` with fresher `branch`/`repo` fields resolved directly
 * from `summary.cwd`, shared by the daemon's per-tick enrichment and the
 * runner's one-shot finalize path so the two never drift. Runs both
 * resolutions concurrently rather than back-to-back, since each is a
 * blocking-if-sync `git` subprocess spawn. No-ops (returns `summary`
 * unchanged) when `cwd` is unset.
 */
export async function applyGitContext(
  summary: SessionSummary,
  resolveGitBranch: (cwd: string) => Promise<string | undefined>,
  resolveGitRepo: (
    cwd: string,
  ) => Promise<{ owner: string; name: string } | undefined>,
): Promise<SessionSummary> {
  if (!summary.cwd) {
    return summary;
  }
  const [branch, repo] = await Promise.all([
    resolveGitBranch(summary.cwd),
    resolveGitRepo(summary.cwd),
  ]);
  return { ...summary, ...(branch && { branch }), ...(repo && { repo }) };
}
