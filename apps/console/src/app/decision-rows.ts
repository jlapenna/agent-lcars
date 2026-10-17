import { repoItemKey } from '../lib/watched-repo';
import {
  type InboxCard,
  inboxCardAgent,
  inboxCardKey,
  inboxCardMetadata,
} from './inbox-card';
import type { DecisionRow } from './ops-panels';
import { actionTypeMeta, queueReasonFor } from './queue-reason';

/** Inbox link that opens one decision, keeping the repository scope. */
export function inboxItemHref(card: InboxCard, repoFilterKey?: string): string {
  const params = new URLSearchParams();
  if (repoFilterKey) params.set('repo', repoFilterKey);
  params.set('item', inboxCardKey(card));
  return `/inbox?${params}`;
}

/**
 * Decision inbox rows (design/fleet-console.html): the reason as an eyebrow,
 * the title, then `repo #N · agent · waiting`. Rows keep the Inbox's own
 * priority order (reason rank, then oldest first). Links stay onsite: the
 * reference opens the task page, the row action opens the decision.
 */
export function decisionRows(
  cards: readonly InboxCard[],
  repoFilterKey?: string,
): DecisionRow[] {
  return [...cards]
    .map((card) => ({ card, meta: inboxCardMetadata(card) }))
    .sort(
      (a, b) =>
        a.meta.rank - b.meta.rank ||
        a.meta.updatedAt.localeCompare(b.meta.updatedAt),
    )
    .map(({ card, meta }) => {
      if ('work' in card) {
        return {
          key: card.work.id,
          reason: actionTypeMeta(meta.actionTypes[0]).label,
          title: card.work.spec.title,
          ref: `${meta.repo.name} work`,
          refHref: `/work/${card.work.id}`,
          agent: inboxCardAgent(card),
          waitingSince: meta.waitingSince,
          respondHref: inboxItemHref(card, repoFilterKey),
        };
      }
      const { item } = card;
      return {
        key: repoItemKey(item.repo, item.number),
        reason: queueReasonFor(item)?.label ?? 'Decision',
        title: item.title,
        ref: `${item.repo.name} ${item.kind === 'pr' ? 'PR ' : ''}#${item.number}`,
        refHref: `/task/${item.repo.owner}/${item.repo.name}/${item.number}`,
        agent: inboxCardAgent(card),
        waitingSince: meta.waitingSince,
        respondHref: inboxItemHref(card, repoFilterKey),
      };
    });
}
