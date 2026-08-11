import { Anchor, Group, Stack } from '@mantine/core';

import type { ActionItem } from '../../lib/action-items';
import { mostRecentSessionForItem } from '../../lib/claimed-idle';
import type { CliSession } from '../../lib/cli-sessions';
import { repoKey } from '../../lib/watched-repo';
import { CompactItemRow } from '../compact-item-row';
import { ItemOverflowMenu } from '../item-overflow-menu';
import { RelativeTime } from '../relative-time';
import { TakeoverCommand } from '../takeover-command';
import { AgentOperationsPanel } from './agent-operations-panel';

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
}: {
  items: ActionItem[];
  /** Every fetched CLI session, any liveness - joined per item (via
   * `mostRecentSessionForItem`) so a maintainer can click into whatever the
   * fleet last did here, even after the session itself went idle/ended
   * (#182). Deliberately not just `activeSessions`: an item only lands in
   * this section *because* it has no active session behind it. */
  cliSessions?: CliSession[];
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
