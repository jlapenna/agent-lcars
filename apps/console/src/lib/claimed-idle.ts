import { type ActionItem, AGENT_FLEET_LOGIN } from './action-items';
import type { CliSession } from './cli-sessions';

/**
 * True when a CLI session is plausibly working the given item number -
 * either through its joined PR (the strong signal: a transcript-recorded PR
 * number, or a live branch->PR search result, see `cli-sessions.ts`) or
 * because the number appears in the session's branch name (this repo's
 * branch convention is `<slug>-<issueNumber>`, e.g. this very page's own
 * `agent-lcars-agents-page-3024` - useful for a session still working an
 * issue that has no PR open yet). The branch match is bounded by
 * non-digit/start/end so item #3 doesn't false-match a branch mentioning
 * `#30` or `#303`.
 */
export function sessionReferencesItemNumber(
  session: Pick<CliSession, 'pr' | 'branch'>,
  itemNumber: number,
): boolean {
  if (session.pr?.number === itemNumber) return true;
  if (!session.branch) return false;
  return new RegExp(`(?:^|[^0-9])${itemNumber}(?:[^0-9]|$)`).test(
    session.branch,
  );
}

/**
 * The open item a CLI session is working, if any - the reverse join used to
 * surface an item's takeover command next to the session actually working
 * it (see `active-agents-section.tsx`).
 */
export function findItemForSession(
  session: CliSession,
  items: ActionItem[],
): ActionItem | undefined {
  return items.find((item) =>
    sessionReferencesItemNumber(session, item.number),
  );
}

/**
 * Open items the agent fleet has claimed (assignee `jclaw-bot`, #2783) but
 * which have no live CI run and no live/idle CLI session actually working
 * them - a stale claim per orchestration.md §4 ("jclaw-bot assigned but no
 * in-progress run named #N ⇒ claim is stale; any session may take over").
 * Before the /agents page existed, these were only discoverable by noticing
 * silence on an issue.
 */
export function deriveClaimedIdle(
  items: ActionItem[],
  hasLiveRun: (item: ActionItem) => boolean,
  activeSessions: CliSession[],
): ActionItem[] {
  return items.filter(
    (item) =>
      item.assigneeLogins.includes(AGENT_FLEET_LOGIN) &&
      !hasLiveRun(item) &&
      !activeSessions.some((session) =>
        sessionReferencesItemNumber(session, item.number),
      ),
  );
}
