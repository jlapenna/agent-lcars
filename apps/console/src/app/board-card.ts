import type { ActionItem } from '../lib/action-items';
import type { PrimaryAction } from '../lib/primary-action';

/** Split out of action-items-board.tsx so your-queue-section.tsx (a client
 * component action-items-board.tsx imports) can use the type without an
 * import cycle back to action-items-board.tsx itself. */
export interface BoardCard {
  item: ActionItem;
  updatedAtLabel: string;
  primaryAction?: PrimaryAction;
}
