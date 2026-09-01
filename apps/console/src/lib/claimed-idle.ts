import { type ActionItem } from './action-items';
import type { CliSession } from './cli-sessions';
import { agentFleetLogin } from './deployment';
import { repoKey } from './watched-repo';

/**
 * True when a CLI session is plausibly working the given item - either
 * through its joined PR (the strong signal: a transcript-recorded PR
 * number) or
 * because the number appears in the session's branch name (this repo's
 * branch convention is `<slug>-<issueNumber>`, e.g. this very page's own
 * `agent-lcars-agents-page-3024` - useful for a session still working an
 * issue that has no PR open yet). The branch match is bounded by
 * non-digit/start/end so item #3 doesn't false-match a branch mentioning
 * `#30` or `#303`.
 *
 * Requires the session's own repo to match the item's repo first - item
 * numbers (and the PR numbers joined onto a session) only disambiguate
 * within one repo, so without this check two watched repos each holding a
 * `#42` would false-match every CLI session working either one to *both*
 * items. A repo-less CLI session is host-scoped, so it cannot claim a
 * GitHub item by number alone.
 */
export function sessionReferencesItemNumber(
  session: Pick<CliSession, 'pr' | 'branch' | 'repo'>,
  item: Pick<ActionItem, 'number' | 'repo'>,
): boolean {
  if (!session.repo || repoKey(session.repo) !== repoKey(item.repo)) {
    return false;
  }
  if (session.pr?.number === item.number) return true;
  if (!session.branch) return false;
  return new RegExp(`(?:^|[^0-9])${item.number}(?:[^0-9]|$)`).test(
    session.branch,
  );
}

/**
 * The most recent CLI session that referenced this item, if any - unlike
 * `deriveClaimedIdle`, this deliberately does not care whether the session
 * is still live/idle. It backs the Claimed but Idle
 * section's "session" link (#182): those items are *defined* by having no
 * active session behind them, but the fleet may well have worked one to
 * completion (or left it stale) before the claim went idle, and that
 * history is exactly what a maintainer wants to click into. `sessions` must
 * already be newest-`lastActivityAt`-first, as `getCliSessions()` returns
 * it - this just takes the first match rather than re-sorting.
 */
export function mostRecentSessionForItem(
  item: ActionItem,
  sessions: CliSession[],
): CliSession | undefined {
  return sessions.find((session) => sessionReferencesItemNumber(session, item));
}

/**
 * Open items the agent fleet has claimed (assignee `agent-lcars-bot`, #2783) but
 * which have no live CI run and no live/idle CLI session actually working
 * them - a stale claim per orchestration.md §4 ("agent-lcars-bot assigned but no
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
      item.assigneeLogins.includes(agentFleetLogin()) &&
      !hasLiveRun(item) &&
      !activeSessions.some((session) =>
        sessionReferencesItemNumber(session, item),
      ),
  );
}
