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
  'merge-blocked': {
    type: 'merge-blocked',
    label: 'Merge blocked',
    color: 'yellow',
    rank: 4,
  },
  'silent-error': {
    type: 'silent-error',
    label: 'Silent error',
    color: 'orange',
    rank: 5,
  },
  'post-deploy-action': {
    type: 'post-deploy-action',
    label: 'Awaiting deploy',
    color: 'gray',
    rank: 6,
  },
};

const HIDDEN_ROUTING_LABELS = new Set([
  'agent:claude',
  'agent:codex',
  'agent:opencode',
  'status:ready-for-agent',
  'status:needs-human',
]);

/** Canonical label/color/rank for one action type. */
export function actionTypeMeta(type: ActionType): QueueReason {
  return QUEUE_REASONS[type];
}

/** The Inbox filter menu's reasons, rank order - every type except
 * post-deploy-action, which the Deck's Waiting-on-Deploy section owns and
 * the Inbox never lists. */
export const INBOX_FILTER_REASONS: QueueReason[] = Object.values(QUEUE_REASONS)
  .filter((reason) => reason.type !== 'post-deploy-action')
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
