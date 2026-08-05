import type { ActionItem } from '../lib/action-items';
import type { PrimaryAction } from '../lib/primary-action';

/** Shared queue-card data passed from server routes into client workspaces. */
export interface BoardCard {
  item: ActionItem;
  primaryAction?: PrimaryAction;
}
