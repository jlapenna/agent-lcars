import type { ActionItem } from './action-items';

export type Pipeline = 'claude' | 'codex' | 'opencode';

/**
 * The single next thing the maintainer should do with a queue item. Every
 * card in "Your Queue" leads with exactly one of these; all other operations
 * (retrigger, takeover, view on GitHub) are secondary. Derived, not stored -
 * the same rules the queue bucketing uses, one level more specific.
 */
export type PrimaryAction =
  | { kind: 'approve-merge' }
  | { kind: 'approve-rebase' }
  | { kind: 'reply' }
  | { kind: 'fix-ci'; checkName: string; checkUrl: string };

/**
 * Answer an explicit human question first, then repair known CI failures
 * before offering approval. Queue sorting does not imply merge readiness.
 */
export function derivePrimaryAction(
  item: ActionItem,
): PrimaryAction | undefined {
  if (item.actionTypes.includes('needs-human')) {
    return { kind: 'reply' };
  }
  if (item.actionTypes.includes('run-failed')) {
    const check = item.failingChecks?.[0];
    return check
      ? { kind: 'fix-ci', checkName: check.name, checkUrl: check.url }
      : undefined;
  }
  if (
    item.kind === 'pr' &&
    item.actionTypes.includes('review-requested') &&
    !item.draft
  ) {
    // 'behind' means the base branch has moved past the PR's fork point -
    // squash-merging right away would either 405 or skip re-running checks
    // against the latest base, so this button instead catches the branch up
    // and lets auto-merge land it once checks pass (see approveAndRebasePr).
    return item.mergeableState === 'behind'
      ? { kind: 'approve-rebase' }
      : { kind: 'approve-merge' };
  }
  return undefined;
}
