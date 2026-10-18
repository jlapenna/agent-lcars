import 'server-only';

import type { BoardCard } from './board-card';
import { ConsoleMarkdown } from './console-markdown';
import {
  type InboxCard,
  inboxCardKey,
  inboxDetailMarkdownKeys,
  nativeCardText,
  type NativeDecisionCard,
} from './inbox-card';

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

/** Native cards carry the parked question or the report as Markdown. */
export function renderInboxCardMarkdown(card: InboxCard): InboxCard {
  if (!('work' in card)) return renderCardMarkdown(card);
  return {
    ...card,
    question: <ConsoleMarkdown>{nativeCardText(card)}</ConsoleMarkdown>,
  } satisfies NativeDecisionCard;
}

/** Render Markdown into the listed cards the detail pane can actually show, and
 * leave every hidden row as plain data. With a decision selected the hidden
 * rows would otherwise each carry a parsed body through the client boundary the
 * selected decision's interaction hydrates behind. Browse mode keeps Markdown
 * on every card because the detail follows client-side filtering. */
export function renderInboxListMarkdown(
  cards: InboxCard[],
  selectedItemKey?: string,
): InboxCard[] {
  const keys = inboxDetailMarkdownKeys(selectedItemKey);
  if (keys === 'all') return cards.map(renderInboxCardMarkdown);
  return cards.map((card) =>
    keys.has(inboxCardKey(card)) ? renderInboxCardMarkdown(card) : card,
  );
}
