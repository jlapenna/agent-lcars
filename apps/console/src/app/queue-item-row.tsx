'use client';

import { Badge, Group, Stack, Text, Tooltip } from '@mantine/core';
import Link from 'next/link';

import { repoDisplayName } from '../lib/watched-repo';
import type { BoardCard } from './board-card';
import { ItemOverflowMenu } from './item-overflow-menu';
import { queueDisclosureLabels, queueReasonFor } from './queue-reason';

export function QueueItemRow({
  card,
  href,
  selected,
  muted,
  onToggleMute,
}: {
  card: BoardCard;
  href: string;
  selected: boolean;
  muted?: boolean;
  onToggleMute?: () => void;
}) {
  const { item, updatedAtLabel } = card;
  const reason = queueReasonFor(item);
  const hiddenLabels = queueDisclosureLabels(item);

  return (
    <div
      className="queue-item-row"
      data-selected={selected ? '' : undefined}
      data-reason={reason?.type}
      data-testid={`queue-row-${item.number}`}
    >
      <Link
        href={href}
        scroll={false}
        className="queue-item-row__link"
        aria-current={selected ? 'true' : undefined}
      >
        <Stack gap={5}>
          <Group justify="space-between" gap="xs" wrap="nowrap">
            <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
              <Badge
                variant="outline"
                color="gray"
                size="xs"
                className="queue-kind-badge"
              >
                {item.kind === 'pr' ? 'PR' : 'Issue'}
              </Badge>
              <Text
                component="span"
                size="xs"
                c="dimmed"
                ff="monospace"
                truncate
              >
                {repoDisplayName(item.repo)} / #{item.number}
              </Text>
            </Group>
            {reason && (
              <Badge
                color={reason.color}
                variant="light"
                size="sm"
                className="queue-reason-badge"
              >
                {reason.label}
              </Badge>
            )}
          </Group>

          <Tooltip label={item.title} multiline maw={320} openDelay={300}>
            <Text
              component="span"
              fw={600}
              size="sm"
              className="queue-item-row__title"
            >
              {item.title}
            </Text>
          </Tooltip>

          <Group justify="space-between" gap="xs" wrap="nowrap">
            <Text component="span" size="xs" c="dimmed" truncate>
              {item.author ? `by ${item.author} · ` : ''}
              {updatedAtLabel}
            </Text>
            {hiddenLabels.length > 0 && (
              <Badge
                variant="outline"
                color="gray"
                size="xs"
                className="queue-label-count"
                aria-label={`${hiddenLabels.length} labels shown in detail`}
              >
                +{hiddenLabels.length}
              </Badge>
            )}
          </Group>
        </Stack>
      </Link>

      <div className="queue-item-row__overflow">
        <ItemOverflowMenu
          item={item}
          muted={muted}
          onToggleMute={onToggleMute}
        />
      </div>
    </div>
  );
}
