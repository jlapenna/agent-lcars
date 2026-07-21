import { Anchor, Badge, Group, Text } from '@mantine/core';

import type { ActionItem } from '../lib/action-items';

/**
 * A one-line row for items that need no decision from the maintainer right
 * now (handed back, waiting on deploy, everything else). Deliberately has
 * no action buttons beyond what the caller passes in `action` - full-weight
 * controls on non-actionable rows made everything look equally urgent.
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
    <Group gap="xs" wrap="nowrap" data-testid={`compact-item-${item.number}`}>
      <Badge variant="outline" color="gray" size="xs" style={{ flexShrink: 0 }}>
        {item.kind === 'pr' ? 'PR' : 'Issue'}
      </Badge>
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
      <Text size="xs" c="dimmed" style={{ marginLeft: 'auto', flexShrink: 0 }}>
        {hint}
      </Text>
      {action}
    </Group>
  );
}
