'use client';

import { ActionIcon, Anchor, Menu } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import type { ActionItem } from '../lib/action-items';
import { CONSOLE_DESTINATIONS, type NavKey } from './console-navigation';
import { useItemOverflowMenu } from './item-overflow-menu';
import { ThemeToggle } from './theme-toggle';

export function QueueUtilityMenu({
  signOutControl,
  repositoryUrl,
  includeNavigation = false,
  navigationHrefs,
  item,
}: {
  signOutControl: ReactNode;
  repositoryUrl: string;
  includeNavigation?: boolean;
  navigationHrefs?: Partial<Record<NavKey, string>>;
  /** When set, folds that item's `ItemOverflowMenu` actions into this same
   * dropdown instead of showing a second dots trigger next to it - a
   * compact header (e.g. the task detail page's mobile utilities) has room
   * for only one overflow icon (agent-lcars#1676). */
  item?: ActionItem;
}) {
  const itemActions = useItemOverflowMenu(item);

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          size={44}
          disabled={itemActions.isPending}
          loading={itemActions.isPending}
          aria-label="More console options"
          className="queue-utility-trigger"
        >
          <IconDotsVertical aria-hidden="true" size={18} stroke={1.7} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown className="queue-utility-menu">
        {itemActions.hasActions && (
          <>
            <Menu.Label>{`#${item?.number}`}</Menu.Label>
            {itemActions.items}
            <Menu.Divider />
          </>
        )}
        {includeNavigation && (
          <>
            <Menu.Label>Navigate</Menu.Label>
            {CONSOLE_DESTINATIONS.map((destination) => (
              <Menu.Item
                key={destination.key}
                component={Link}
                href={navigationHrefs?.[destination.key] ?? destination.href}
              >
                {destination.label}
              </Menu.Item>
            ))}
            <Menu.Divider />
          </>
        )}
        <Menu.Label>Console</Menu.Label>
        <div className="queue-utility-menu__control">
          <ThemeToggle />
        </div>
        <div className="queue-utility-menu__control">{signOutControl}</div>
        <Anchor
          href={repositoryUrl}
          target="_blank"
          rel="noreferrer"
          size="xs"
          c="dimmed"
          className="queue-utility-menu__control"
        >
          Open repository ↗
        </Anchor>
      </Menu.Dropdown>
      {itemActions.modal}
    </Menu>
  );
}
