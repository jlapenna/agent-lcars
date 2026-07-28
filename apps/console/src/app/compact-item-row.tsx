import { Anchor, Badge, Group, Stack, Text } from '@mantine/core';

import type { ActionItem } from '../lib/action-items';
import { RepoBadge } from './agent-activity-panel';

/**
 * A two-line row for items that need no decision from the maintainer right
 * now (handed back, waiting on deploy, everything else). Deliberately has
 * no action buttons beyond what the caller passes in `action` - full-weight
 * controls on non-actionable rows made everything look equally urgent. The
 * second line always renders (`hint` is required) so every row carries at
 * least two lines of information, same as the fuller rows elsewhere on the
 * board (#169) - it folds in author/labels when the item has them, rather
 * than leaving that second line as filler.
 */
export function CompactItemRow({
  item,
  hint,
  action,
}: {
  item: ActionItem;
  /** One dimmed clause of context, e.g. "updated 2 hours ago". */
  hint: string;
  action?: React.ReactNode;
}) {
  return (
    <Stack gap={2} data-testid={`compact-item-${item.number}`}>
      <Group gap="xs" wrap="nowrap" align="center">
        <Badge
          variant="outline"
          color="gray"
          size="xs"
          style={{ flexShrink: 0 }}
        >
          {item.kind === 'pr' ? 'PR' : 'Issue'}
        </Badge>
        <RepoBadge repo={item.repo} />
        <Anchor
          href={item.url}
          target="_blank"
          rel="noreferrer"
          size="sm"
          c="inherit"
          truncate
          style={{ minWidth: 0 }}
        >
          #{item.number} {item.title}
        </Anchor>
      </Group>
      <Group gap="xs" wrap="nowrap" align="center">
        <Text size="xs" c="dimmed" truncate style={{ minWidth: 0 }}>
          {hint}
          {item.author && ` · by ${item.author}`}
          {item.labels.length > 0 && ` · ${item.labels.join(', ')}`}
        </Text>
        {action}
      </Group>
    </Stack>
  );
}
