import type { ActionItem } from './action-items';

export type Pipeline = 'claude' | 'opencode';

/**
 * Which agent pipeline - claude.yml, or the experimental opencode.yml
 * (#2988/#2994) - a console reply or retrigger on this item should target,
 * derived from its labels. Pure and client-safe by design (unlike
 * `backend-actions.ts`, which pulls in `@octokit/rest`) so it can run
 * inside `action-item-card.tsx` (a client component) as well as server-side
 * in `postComment`/`retriggerIssue`.
 *
 * `/oc` is opencode.yml's ONLY reply channel - a plain `@claude` mention
 * does nothing for it, so an opencode-only item has to route there instead
 * of the default. When an item carries BOTH labels, `claude` wins: a single
 * console action (one reply, one retrigger) must never dispatch two agent
 * pipelines at once.
 */
export function pipelineForLabels(labels: string[]): Pipeline {
  return labels.includes('opencode') && !labels.includes('claude')
    ? 'opencode'
    : 'claude';
}

/**
 * The single next thing the maintainer should do with a queue item. Every
 * card in "Your Queue" leads with exactly one of these; all other operations
 * (retrigger, takeover, view on GitHub) are secondary. Derived, not stored -
 * the same rules the queue bucketing uses, one level more specific.
 */
export type PrimaryAction =
  | { kind: 'approve-merge' }
  | { kind: 'reply' }
  | { kind: 'fix-ci'; checkName: string; checkUrl: string };

/**
 * Priority mirrors ACTION_PRIORITY in action-items.ts: an open review
 * request or a human-needed question outranks a failing run (an agent may
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
    return { kind: 'approve-merge' };
  }
  if (item.actionTypes.includes('human-needed')) {
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
