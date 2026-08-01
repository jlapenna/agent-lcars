import type { ActionItem, ActionType } from '../lib/action-items';

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
  'run-failed': {
    type: 'run-failed',
    label: 'Run failed',
    color: 'red',
    rank: 2,
  },
  'merge-blocked': {
    type: 'merge-blocked',
    label: 'Merge blocked',
    color: 'yellow',
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
};

const HIDDEN_ROUTING_LABELS = new Set([
  'agent:claude',
  'agent:codex',
  'agent:opencode',
  'status:needs-human',
]);

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
