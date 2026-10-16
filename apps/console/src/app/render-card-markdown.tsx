import 'server-only';

import type { BoardCard } from './board-card';
import type { InboxCard, NativeDecisionCard } from './inbox-card';
import { nativeDecisionQuestion } from './inbox-card';
import { ConsoleMarkdown } from './console-markdown';

/** Keep parsing server-known bodies out of the interactive card's client graph.
 * Return the same fresh item and action; only its rendered context is added. */
export function renderCardMarkdown(card: BoardCard): BoardCard {
  return {
    ...card,
    description: card.item.body ? (
      <ConsoleMarkdown>{card.item.body}</ConsoleMarkdown>
    ) : undefined,
    lastComment: card.item.lastCommentBody ? (
      <ConsoleMarkdown>{card.item.lastCommentBody}</ConsoleMarkdown>
    ) : undefined,
  };
}

/** Native decisions carry the agent's parked question as Markdown. */
export function renderInboxCardMarkdown(card: InboxCard): InboxCard {
  if (!('work' in card)) return renderCardMarkdown(card);
  return {
    ...card,
    question: (
      <ConsoleMarkdown>{nativeDecisionQuestion(card.work)}</ConsoleMarkdown>
    ),
  } satisfies NativeDecisionCard;
}
