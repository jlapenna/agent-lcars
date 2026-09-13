import type { ActionItem } from '../lib/action-items';
import type { AgentRun } from '../lib/agent-activity';
import type { CliSession } from '../lib/cli-sessions';
import { repoItemKey } from '../lib/watched-repo';

/**
 * The Bridge's master/detail selection lives in the URL (`?sel=`) rather than
 * component state, exactly like the Inbox's `?item=` - so a shared link lands
 * on the same selected row and Back/Forward round-trips it. The key is a
 * kind-namespaced id, because the Bridge's left column is a *unified* list of
 * heterogeneous rows (live runs, recent outcomes, CLI sessions, and the
 * deploy-wait items), and a bare run id could otherwise collide with a session
 * id or an issue key.
 */
export type BridgeSelectionKey = string;

const RUN_PREFIX = 'run:';
const SESSION_PREFIX = 'session:';
const ITEM_PREFIX = 'item:';

export const SEL_PARAM = 'sel';

export function runKey(run: AgentRun): BridgeSelectionKey {
  return `${RUN_PREFIX}${run.id}`;
}

export function sessionKey(session: CliSession): BridgeSelectionKey {
  return `${SESSION_PREFIX}${session.sessionId}`;
}

export function itemKey(item: ActionItem): BridgeSelectionKey {
  return `${ITEM_PREFIX}${repoItemKey(item.repo, item.number)}`;
}

export function parseBridgeSelection(
  value: string | undefined,
): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

/**
 * Build the Bridge href that selects `key`, preserving the active repo scope
 * and clearing any prior selection back to bare `/`. Kept as a plain string
 * builder (not `useSearchParams`) so the server page can render selection links
 * without a client boundary.
 */
export function bridgeSelectionHref(
  key: BridgeSelectionKey | undefined,
  repoFilterKey?: string,
): string {
  const params = new URLSearchParams();
  if (repoFilterKey) params.set('repo', repoFilterKey);
  if (key) params.set(SEL_PARAM, key);
  const query = params.toString();
  return query ? `/?${query}` : '/';
}
