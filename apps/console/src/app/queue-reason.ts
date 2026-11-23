import type { ActionItem, ActionType } from '../lib/action-items';

/**
 * The single source of truth for how an action type reads anywhere in the
 * UI - list rows, the detail card's badges, and the Inbox filter menu all
 * pull from here, so one type can never read three different ways
 * depending on which surface happens to render it.
 */
export interface QueueReason {
  type: ActionType;
  label: string;
  color: string;
  rank: number;
}

const QUEUE_REASONS: Record<ActionType, QueueReason> = {
  'needs-human': {
    type: 'needs-human',
    label: 'Human needed',
    color: 'blue',
    rank: 0,
  },
  'review-requested': {
    type: 'review-requested',
    label: 'Review requested',
    color: 'grape',
    rank: 1,
  },
  'ready-for-agent': {
    type: 'ready-for-agent',
    label: 'Ready for agent',
    color: 'cyan',
    rank: 2,
  },
  'run-failed': {
    type: 'run-failed',
    label: 'Run failed',
    color: 'red',
    rank: 3,
  },
  'silent-error': {
    type: 'silent-error',
    label: 'Silent error',
    color: 'orange',
    rank: 4,
  },
  'post-deploy-action': {
    type: 'post-deploy-action',
    label: 'Awaiting deploy',
    color: 'gray',
    rank: 5,
  },
  blocked: {
    type: 'blocked',
    label: 'Blocked',
    color: 'gray',
    rank: 6,
  },
  // Below every decision: a report is read, never answered.
  'report-ready': {
    type: 'report-ready',
    label: 'Report ready',
    color: 'teal',
    rank: 5,
  },
};

/** Reasons that describe a wait rather than a decision. They rank last so an
 *  item that is blocked *and* needs a human reads as the decision it is, and
 *  the Inbox filter menu never offers them: wait-only work is the Bridge's,
 *  never the Inbox's (`isWaitOnly` in action-items.ts). */
const WAIT_REASONS: ReadonlySet<ActionType> = new Set([
  'post-deploy-action',
  'blocked',
]);

const HIDDEN_ROUTING_LABELS = new Set([
  'agent:claude',
  'agent:codex',
  'agent:opencode',
  'agent:agy',
  'status:ready-for-agent',
  'status:needs-human',
]);

/** Canonical label/color/rank for one action type. */
export function actionTypeMeta(type: ActionType): QueueReason {
  return QUEUE_REASONS[type];
}

/** The Inbox filter menu's reasons, rank order - every decision type; the
 * wait reasons belong to the Bridge's own sections. */
export const INBOX_FILTER_REASONS: QueueReason[] = Object.values(QUEUE_REASONS)
  .filter((reason) => !WAIT_REASONS.has(reason.type))
  .sort((a, b) => a.rank - b.rank);

export function queueReasonFor(item: ActionItem): QueueReason | undefined {
  let best: QueueReason | undefined;
  for (const type of item.actionTypes) {
    const candidate = QUEUE_REASONS[type];
    if (!best || candidate.rank < best.rank) best = candidate;
  }
  return best;
}

export function queueDisclosureLabels(item: ActionItem): string[] {
  return item.labels.filter((label) => !HIDDEN_ROUTING_LABELS.has(label));
}

/**
 * Diagnostic thread-count badge shown on pull request cards that carry
 * unresolved review threads (#538). Unresolved threads no longer queue a PR
 * into the Decision Inbox on their own, so this renders only when the PR is
 * viewed on its task detail page or queued for an actual human decision.
 */
export function mergeBlockedReason(item: ActionItem): string | undefined {
  const count = item.unresolvedReviewThreadCount;
  if (!count) return undefined;
  return `${count} unresolved review thread${count === 1 ? '' : 's'}`;
}
