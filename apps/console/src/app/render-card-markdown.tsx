import 'server-only';

import type { BoardCard } from './board-card';
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
