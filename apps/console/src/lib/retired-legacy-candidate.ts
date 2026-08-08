import { DISPATCH_LABELS } from '@agent-lcars/dispatch-contracts';
import type { IssueOrPullRequest } from '@agent-lcars/dispatch-controller/normalize';

const dispatchLabels = new Set<string>(DISPATCH_LABELS);

/**
 * Authority cutover deliberately fails closed when an old task missed exact
 * state backfill. A closed task is the one safe exception when live GitHub
 * state proves that it predates cutover and carries no dispatch intent. Both
 * reconciliation and delayed webhook replay use this same boundary so
 * retired compatibility-only tasks cannot become an infinite retry backlog.
 *
 * Keep this narrower than "closed means safe". A post-cutover gap indicates
 * a new writer bug, and a closed issue that still carries agent/review intent
 * may need controller convergence. An invalid epoch also fails closed.
 */
export function isRetiredLegacyCandidate(
  issue: IssueOrPullRequest,
  authorityEpoch: string,
): boolean {
  if (issue.state !== 'closed') return false;
  if (
    (issue.labels ?? []).some((label) =>
      dispatchLabels.has(typeof label === 'string' ? label : label.name),
    )
  ) {
    return false;
  }
  const createdAt = Date.parse(issue.created_at);
  const cutoverAt = Date.parse(authorityEpoch);
  return (
    Number.isFinite(createdAt) &&
    Number.isFinite(cutoverAt) &&
    createdAt < cutoverAt
  );
}
