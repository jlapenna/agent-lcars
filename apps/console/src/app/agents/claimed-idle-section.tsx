import { Anchor, Card, Group, Stack, Text, Title } from '@mantine/core';

import type { ActionItem } from '../../lib/action-items';
import { mostRecentSessionForItem } from '../../lib/claimed-idle';
import type { CliSession } from '../../lib/cli-sessions';
import { agentFleetLogin } from '../../lib/deployment';
import { repoKey } from '../../lib/watched-repo';
import { CompactItemRow } from '../compact-item-row';
import { ItemOverflowMenu } from '../item-overflow-menu';
import { lcarsPanelStyle } from '../lcars';
import { RelativeTime } from '../relative-time';
import { TakeoverCommand } from '../takeover-command';

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
  return (
    <Card
      withBorder
      radius="md"
      padding="md"
      mb="xl"
      data-testid="claimed-idle-section"
      className="lcars-panel agents-panel agents-panel--claimed"
      style={lcarsPanelStyle('periwinkle')}
    >
      <Stack gap="sm">
        <Title order={2} size="h4">
          Claimed but Idle ({items.length})
        </Title>
        {items.length === 0 ? (
          <Text size="sm" c="dimmed">
            Every {agentFleetLogin()} claim has a live run or session behind it.
          </Text>
        ) : (
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
        )}
      </Stack>
    </Card>
  );
}
