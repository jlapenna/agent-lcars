import { Anchor, Badge, Group, Stack } from '@mantine/core';

import type { ActionItem } from '../../lib/action-items';
import type { AuthoritativeTaskState } from '../../lib/authoritative-task-state';
import { mostRecentSessionForItem } from '../../lib/claimed-idle';
import type { CliSession } from '../../lib/cli-sessions';
import { repoItemKey, repoKey } from '../../lib/watched-repo';
import { CompactItemRow } from '../compact-item-row';
import { ItemOverflowMenu } from '../item-overflow-menu';
import { RelativeTime } from '../relative-time';
import { TakeoverCommand } from '../takeover-command';
import { AgentOperationsPanel } from './agent-operations-panel';

/**
 * The orchestrator's own view of whether this item's mutex is actually
 * held, independent of the attempts/CLI-session signal that put it in this
 * section in the first place (#1015). `deriveClaimedIdle` only sees a GitHub
 * Actions attempt or a live/idle CLI session as "live" - a run the
 * orchestrator has decided but not yet dispatched (`pending`), or one whose
 * attempt fell out of the console's own visibility, would still show up
 * here as a false "idle" claim without this. Absent authoritative state
 * (repo outside the orchestrator's coverage, or the read failed) renders
 * nothing, same as `LogicalWorkCard`'s own `provenance: 'unavailable'`
 * handling.
 */
function activeOrchestratorRun(state: AuthoritativeTaskState | undefined) {
  if (!state?.activeRunId) return undefined;
  return state.runs.find((run) => run.runId === state.activeRunId);
}

/**
 * "Claimed but Idle": open items the fleet has claimed (assignee
 * `jclaw-bot`) with no live run and no live/idle CLI session actually
 * working them - see deriveClaimedIdle in claimed-idle.ts. A stale claim
 * per orchestration.md §4 ("jclaw-bot assigned but no in-progress run
 * named #N ⇒ claim is stale; any session may take over"). Before this
 * section existed these were only discoverable by noticing silence on an
 * issue.
 */
export function ClaimedIdleSection({
  items,
  cliSessions = [],
  authoritativeStates,
}: {
  items: ActionItem[];
  /** Every fetched CLI session, any liveness - joined per item (via
   * `mostRecentSessionForItem`) so a maintainer can click into whatever the
   * fleet last did here, even after the session itself went idle/ended
   * (#182). Deliberately not just `activeSessions`: an item only lands in
   * this section *because* it has no active session behind it. */
  cliSessions?: CliSession[];
  /** The same orchestrator-authoritative read `page.tsx` already fetches
   * for every item on this page (see `readAuthoritativeTaskStates`) -
   * surfaces a "locked" badge when the orchestrator disagrees with this
   * section's own attempts/session-based idleness signal (#1015). */
  authoritativeStates?: Map<string, AuthoritativeTaskState>;
}) {
  // This panel exists to surface a problem that needs intervention. An empty
  // "all clear" panel pushes the working set below the fold while adding no
  // decision or action, so let the live Fleet strip be the quiet healthy
  // state and reserve this space for actual stale claims.
  if (items.length === 0) return null;

  return (
    <AgentOperationsPanel
      title={`Claimed but Idle (${items.length})`}
      className="agents-panel--claimed"
      testId="claimed-idle-section"
      separated
    >
      <Stack gap="xs">
        {items.map((item) => {
          const session = mostRecentSessionForItem(item, cliSessions);
          const activeRun = activeOrchestratorRun(
            authoritativeStates?.get(repoItemKey(item.repo, item.number)),
          );
          return (
            <Stack
              key={`${repoKey(item.repo)}-${item.kind}-${item.number}`}
              gap={4}
            >
              <CompactItemRow
                item={item}
                hint={
                  <>
                    updated <RelativeTime iso={item.updatedAt} />
                  </>
                }
                action={
                  <Group gap={4} wrap="nowrap">
                    {activeRun && (
                      <Badge
                        variant="filled"
                        color="blue"
                        size="xs"
                        data-testid="claimed-idle-active-run"
                      >
                        locked · {activeRun.state}
                      </Badge>
                    )}
                    {session && (
                      <Anchor
                        href={`/sessions/${session.sessionId}`}
                        size="xs"
                        c="dimmed"
                        data-testid="claimed-idle-session-link"
                      >
                        session
                      </Anchor>
                    )}
                    <ItemOverflowMenu item={item} />
                  </Group>
                }
              />
              {item.takeoverCommand && (
                <TakeoverCommand command={item.takeoverCommand} />
              )}
            </Stack>
          );
        })}
      </Stack>
    </AgentOperationsPanel>
  );
}
