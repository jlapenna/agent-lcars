import type { Run as OrchestratorRun } from '@agent-lcars/orchestrator';

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
 * A fleet claim that is idle on purpose is not a stale claim, and this
 * section exists to surface stale ones:
 *
 * - `status:blocked` says the item is parked on something external; the
 *   Bridge's Blocked section owns it (label contract: "an external
 *   dependency or prerequisite is preventing progress").
 * - A Renovate-maintained item (`bot:renovate` - the Dependency Dashboard)
 *   is a standing anchor the fleet keeps claimed so dependency work routes
 *   to it. It will never have a run of its own and never goes idle.
 */
function isDeliberatelyIdle(item: ActionItem): boolean {
  return (
    item.actionTypes.includes('blocked') || item.labels.includes('bot:renovate')
  );
}

/**
 * Open items the agent fleet has claimed (assignee `agent-lcars-bot`, #2783) but
 * which have no live CI run and no live/idle CLI session actually working
 * them - a stale claim per the agent-lcars-dev skill's issue-ownership guardrail
 * ("agent-lcars-bot assigned but no live run or session ⇒ the claim is
 * stale; take over and say so").
 * Before the /agents page existed, these were only discoverable by noticing
 * silence on an issue. Deliberately idle claims (see `isDeliberatelyIdle`)
 * are not stale and stay out.
 */
export function deriveClaimedIdle(
  items: ActionItem[],
  hasLiveRun: (item: ActionItem) => boolean,
  activeSessions: CliSession[],
): ActionItem[] {
  return items.filter(
    (item) =>
      item.assigneeLogins.includes(agentFleetLogin()) &&
      !isDeliberatelyIdle(item) &&
      !hasLiveRun(item) &&
      !activeSessions.some((session) =>
        sessionReferencesItemNumber(session, item),
      ),
  );
}

export type ClaimedIdleReasonKind =
  'never-dispatched' | 'finished' | 'parked' | 'failed' | 'lost' | 'canceled';

export interface ClaimedIdleReason {
  kind: ClaimedIdleReasonKind;
  label: string;
}

const CLAIMED_IDLE_REASONS: Record<ClaimedIdleReasonKind, string> = {
  'never-dispatched': 'Never dispatched',
  finished: 'Finished, not closed',
  parked: 'Parked',
  failed: 'Last run failed',
  lost: 'Last run lost',
  canceled: 'Last run canceled',
};

/**
 * Why a claimed item is idle, read off the orchestrator's own run history
 * rather than guessed from GitHub. The section only knows an item is idle;
 * the difference between "the fleet never started" and "the fleet finished
 * and nobody closed the anchor" is the difference between redispatching
 * and closing, and it was invisible. Mirrors `deriveItemState`'s reading of
 * a run (`libs/work/src/derive.ts`): an explicit `park` summary is a human
 * handoff, any other finished run is done or failed by `result.ok`.
 *
 * `'absent'` is the orchestrator having no task document for the anchor at
 * all - the read succeeded and found nothing - which is the strongest form
 * of "never dispatched": on the live console it was the common case (10 of
 * 11 idle claims), and rendering nothing for it left the badge looking
 * broken rather than informative. Undefined when there is no authoritative
 * state to read (not fetched, or the read failed), or while the
 * orchestrator still holds a live run - that case is the section's own
 * "locked" badge, and the two must not both render.
 */
export function claimedIdleReason(
  state:
    | { activeRunId?: string; runs: readonly OrchestratorRun[] }
    | 'absent'
    | undefined,
): ClaimedIdleReason | undefined {
  if (state === undefined) return undefined;
  if (state === 'absent') {
    return {
      kind: 'never-dispatched',
      label: CLAIMED_IDLE_REASONS['never-dispatched'],
    };
  }
  if (state.activeRunId !== undefined) return undefined;
  const latest = [...state.runs].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.runId.localeCompare(a.runId, undefined, { numeric: true }),
  )[0];
  const kind: ClaimedIdleReasonKind =
    latest === undefined
      ? 'never-dispatched'
      : latest.state === 'finished'
        ? latest.result?.summary === 'park'
          ? 'parked'
          : latest.result?.ok
            ? 'finished'
            : 'failed'
        : latest.state === 'lost'
          ? 'lost'
          : latest.state === 'canceled'
            ? 'canceled'
            : 'never-dispatched';
  return { kind, label: CLAIMED_IDLE_REASONS[kind] };
}
