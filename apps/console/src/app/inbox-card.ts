import type { WorkSummary } from '@agent-lcars/work/derive';

import { repoItemKey } from '../lib/watched-repo';
import type { BoardCard } from './board-card';
import { queueReasonFor } from './queue-reason';

export interface NativeDecisionCard {
  work: WorkSummary & { anchor: { workId: string } };
  canReply: boolean;
}

export type InboxCard = BoardCard | NativeDecisionCard;

export function inboxCardKey(card: InboxCard): string {
  return 'work' in card
    ? card.work.id
    : repoItemKey(card.item.repo, card.item.number);
}

export function inboxCardMetadata(card: InboxCard) {
  if ('work' in card) {
    const [owner, name] = card.work.spec.target.repo.split('/');
    return {
      title: card.work.spec.title,
      repo: { owner, name },
      identity: card.work.id,
      updatedAt: card.work.updatedAt,
      actionTypes: ['needs-human'] as const,
      rank: 0,
      search: `${card.work.id} ${card.work.spec.title} ${card.work.spec.target.repo} ${card.work.runs.at(-1)?.result?.message ?? ''}`,
    };
  }
  return {
    title: card.item.title,
    repo: card.item.repo,
    identity: `#${card.item.number}`,
    updatedAt: card.item.updatedAt,
    actionTypes: card.item.actionTypes,
    rank: queueReasonFor(card.item)?.rank ?? Number.MAX_SAFE_INTEGER,
    search: `${card.item.title} #${card.item.number} ${card.item.author ?? ''} ${card.item.labels.join(' ')}`,
  };
}
