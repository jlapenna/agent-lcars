import { AGENT_BOT_LOGINS } from '@agent-lcars/dispatch-contracts';
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
 * The fleet's assignee is a monotonic marker: dispatch adds it, and by the
 * ownership rule only a human ever removes it, so it outlives every
 * hand-back. Reading it alone as "the fleet owns this and is doing nothing"
 * therefore decays into noise - every parked, handed-back, blocked, or
 * standing anchor the fleet ever touched. A stale claim is one where the
 * fleet is the *sole* idle owner and nothing says otherwise:
 *
 * - A human assignee owns the item (agent-lcars-dev's ownership guardrail:
 *   "a human assignee owns the issue"); the fleet's mark is subordinate.
 * - `status:needs-human` is the hand-back itself: the ball is in the
 *   maintainer's court and the Inbox already lists it. Listing it here too
 *   read as "stale, take over", which is the opposite of what it means.
 * - `status:blocked` parks the item on something external; the Bridge's
 *   Blocked section owns it.
 * - `status:ledger` marks an anchor kept open on purpose as a durable
 *   ledger or dashboard, never a work item (e.g. sprinkles#4664).
 * - `bot:renovate` (the Dependency Dashboard) is the same shape: a standing
 *   anchor the fleet keeps claimed so dependency work routes to it.
 */
function claimBelongsElsewhere(item: ActionItem): boolean {
  const fleet = agentFleetLogin();
  const humanAssignee = item.assigneeLogins.some(
    (login) => login !== fleet && !AGENT_BOT_LOGINS.includes(login),
  );
  return (
    humanAssignee ||
    item.actionTypes.includes('needs-human') ||
    item.actionTypes.includes('blocked') ||
    item.labels.includes('status:ledger') ||
    item.labels.includes('bot:renovate')
  );
}

/**
 * Open items the agent fleet has claimed but which have no live CI run and
 * no live/idle CLI session actually working them - a stale claim per the
 * agent-lcars-dev skill's issue-ownership guardrail ("agent-lcars-bot
 * assigned but no live run or session ⇒ the claim is stale; take over and
 * say so"). A claim is the fleet's assignee (`agent-lcars-bot`, #2783) *or*
 * an orchestrator task record for the anchor (`hasTaskRecord`) - the
 * orchestrator dispatched it, so it is the fleet's claim even if a human
 * later removed the bot assignee without also closing the loop. Before the
 * /agents page existed, these were only discoverable by noticing silence on
 * an issue. A claim that belongs to someone or something else (see
 * `claimBelongsElsewhere`) is not stale and stays out.
 */
export function deriveClaimedIdle(
  items: ActionItem[],
  hasLiveRun: (item: ActionItem) => boolean,
  activeSessions: CliSession[],
  hasTaskRecord: (item: ActionItem) => boolean,
): ActionItem[] {
  return items.filter(
    (item) =>
      (item.assigneeLogins.includes(agentFleetLogin()) ||
        hasTaskRecord(item)) &&
      !claimBelongsElsewhere(item) &&
      !hasLiveRun(item) &&
      !activeSessions.some((session) =>
        sessionReferencesItemNumber(session, item),
      ),
  );
}

export type ClaimedIdleReasonKind =
  | 'never-dispatched'
  | 'finished'
  | 'parked'
  | 'failed'
  | 'lost'
  | 'canceled'
  | 'observing';

export interface ClaimedIdleReason {
  kind: ClaimedIdleReasonKind;
  label: string;
}

const CLAIMED_IDLE_REASONS: Record<
  Exclude<ClaimedIdleReasonKind, 'observing'>,
  string
> = {
  'never-dispatched': 'Never dispatched',
  finished: 'Finished, not closed',
  parked: 'Parked',
  failed: 'Last run failed',
  lost: 'Last run lost',
  canceled: 'Last run canceled',
};

// UTC, no year - a maintainer skimming this section cares which day the
// window ends, not which timezone or year (an observation window is always
// near-term).
const OBSERVE_UNTIL_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
});

function observingReason(observeUntil: string): ClaimedIdleReason {
  return {
    kind: 'observing',
    label: `Observing until ${OBSERVE_UNTIL_FORMATTER.format(new Date(observeUntil))}`,
  };
}

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
 *
 * `observeUntil` (the `ActionItem`'s parsed `<!-- agent-lcars:observe-until
 * ... -->` marker, see action-items.ts) is a second, independent idle
 * reason: an anchor legitimately waiting on a scheduled event rather than
 * one nobody has looked at. Precedence, checked in this order: a live
 * orchestrator run still wins outright and returns undefined - the
 * section's own "locked" badge owns that case, and it must not also read
 * "observing". Otherwise, an `observeUntil` still in the future (relative
 * to `now`) wins over every run-history reason, including "never
 * dispatched" - the marker is the more specific, more recent statement of
 * intent. Once it is in the past it is stale and is ignored, falling
 * through to the run-history read below exactly as if it were absent.
 */
export function claimedIdleReason(
  state:
    | { activeRunId?: string; runs: readonly OrchestratorRun[] }
    | 'absent'
    | undefined,
  {
    observeUntil,
    now = new Date(),
  }: { observeUntil?: string; now?: Date } = {},
): ClaimedIdleReason | undefined {
  if (
    state !== undefined &&
    state !== 'absent' &&
    state.activeRunId !== undefined
  ) {
    return undefined;
  }
  if (observeUntil !== undefined && Date.parse(observeUntil) > now.getTime()) {
    return observingReason(observeUntil);
  }
  if (state === undefined) return undefined;
  if (state === 'absent') {
    return {
      kind: 'never-dispatched',
      label: CLAIMED_IDLE_REASONS['never-dispatched'],
    };
  }
  const latest = [...state.runs].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.runId.localeCompare(a.runId, undefined, { numeric: true }),
  )[0];
  const kind: Exclude<ClaimedIdleReasonKind, 'observing'> =
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
