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
 * Priority mirrors ACTION_PRIORITY in action-items.ts: an open review
 * request or a needs-human question outranks a failing run (an agent may
 * still be fixing the latter on its own).
 */
export function derivePrimaryAction(
  item: ActionItem,
): PrimaryAction | undefined {
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
  if (item.actionTypes.includes('needs-human')) {
    return { kind: 'reply' };
  }
  if (item.actionTypes.includes('run-failed')) {
    const check = item.failingChecks?.[0];
    if (check) {
      return { kind: 'fix-ci', checkName: check.name, checkUrl: check.url };
    }
  }
  return undefined;
}
