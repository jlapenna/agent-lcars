'use client';

import { ActionIcon, Menu, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useTransition } from 'react';

import type { ActionItem } from '../lib/action-items';
import { clearHumanNeeded, closeIssue } from './actions';

/**
 * The console's "Done" affordance: an overflow menu, shared by queue cards
 * and compact rows, for closing an item's loop without a trip to GitHub.
 * Renders nothing if no action applies to this item.
 */
export function ItemOverflowMenu({
  item,
  muted,
  onToggleMute,
}: {
  item: ActionItem;
  /** Current per-browser mute state (#59) - see use-muted-items.ts. Omit
   * `onToggleMute` entirely on rows that don't offer muting (only "Your
   * Queue" does today). */
  muted?: boolean;
  onToggleMute?: () => void;
}) {
  const [isPending, startTransition] = useTransition();

  const canClose = item.kind === 'issue';
  const canClearHumanNeeded = item.actionTypes.includes('human-needed');
  const canMute = Boolean(onToggleMute);
  if (!canClose && !canClearHumanNeeded && !canMute) return null;

  const handleClose = () => {
    startTransition(async () => {
      const result = await closeIssue(item.repo, item.number);
      if (!result.ok) {
        notifications.show({ message: result.message, color: 'red' });
        return;
      }
      notifications.show({
        message: `#${item.number} closed`,
        color: 'green',
      });
    });
  };

  const confirmClose = () =>
    modals.openConfirmModal({
      title: `Close #${item.number}?`,
      children: (
        <Text size="sm">
          This closes &ldquo;{item.title}&rdquo; on GitHub without posting a
          comment. This can&rsquo;t be undone from here.
        </Text>
      ),
      labels: { confirm: 'Close issue', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: handleClose,
    });

  const handleClearHumanNeeded = () => {
    startTransition(async () => {
      const result = await clearHumanNeeded(item.repo, item.number);
      if (!result.ok) {
        notifications.show({ message: result.message, color: 'red' });
        return;
      }
      notifications.show({
        message: `Cleared needs-human on #${item.number}`,
        color: 'green',
      });
    });
  };

  return (
    <Menu withinPortal position="bottom-end" shadow="md">
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          disabled={isPending}
          aria-label={`More actions for #${item.number}`}
          style={{ flexShrink: 0 }}
        >
          ⋮
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {canClearHumanNeeded && (
          <Menu.Item onClick={handleClearHumanNeeded}>
            Clear needs-human
          </Menu.Item>
        )}
        {canMute && (
          <Menu.Item onClick={onToggleMute}>
            {muted ? 'Unmute' : 'Mute'}
          </Menu.Item>
        )}
        {canClose && (
          <Menu.Item color="red" onClick={confirmClose}>
            Close issue
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
