import { Card, Stack, Text, Title } from '@mantine/core';

import type { ActionItem } from '../../lib/action-items';
import { repoKey } from '../../lib/watched-repo';
import { CompactItemRow } from '../compact-item-row';
import { formatRelativeTime } from '../format';
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
export function ClaimedIdleSection({ items }: { items: ActionItem[] }) {
  return (
    <Card
      withBorder
      radius="md"
      padding="md"
      mb="xl"
      data-testid="claimed-idle-section"
    >
      <Stack gap="sm">
        <Title order={2} size="h4">
          Claimed but Idle ({items.length})
        </Title>
        {items.length === 0 ? (
          <Text size="sm" c="dimmed">
            Every jclaw-bot claim has a live run or session behind it.
          </Text>
        ) : (
          <Stack gap="xs">
            {items.map((item) => (
              <Stack
                key={`${repoKey(item.repo)}-${item.kind}-${item.number}`}
                gap={4}
              >
                <CompactItemRow
                  item={item}
                  hint={`updated ${formatRelativeTime(item.updatedAt)}`}
                />
                {item.takeoverCommand && (
                  <TakeoverCommand command={item.takeoverCommand} />
                )}
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
