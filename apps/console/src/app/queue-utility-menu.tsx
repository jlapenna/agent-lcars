'use client';

import {
  ActionIcon,
  Anchor,
  MenuDivider,
  MenuItem,
  MenuLabel,
} from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import type { ActionItem } from '../lib/action-items';
import { MenuIdentity } from './console-frame-readouts';
import { consoleDestinations, type NavKey } from './console-navigation';
import { useConsoleNavigationKeys } from './console-navigation-context';
import { DeferredMenu } from './deferred-popover';
import { InboxNotificationsToggle } from './inbox-notifications';
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
  const allowedKeys = useConsoleNavigationKeys();

  return (
    <>
      <DeferredMenu
        position="bottom-end"
        dropdownClassName="queue-utility-menu"
        target={(triggerProps) => (
          <ActionIcon
            {...triggerProps}
            variant="subtle"
            size={44}
            disabled={itemActions.isPending}
            loading={itemActions.isPending}
            aria-label="More console options"
            className="queue-utility-trigger"
          >
            <IconDotsVertical aria-hidden="true" size={18} stroke={1.7} />
          </ActionIcon>
        )}
      >
        {itemActions.hasActions && (
          <>
            <MenuLabel>{`#${item?.number}`}</MenuLabel>
            {itemActions.items}
            <MenuDivider />
          </>
        )}
        {includeNavigation && (
          <>
            <MenuLabel>Navigate</MenuLabel>
            {consoleDestinations(allowedKeys).map((destination) => (
              <MenuItem
                key={destination.key}
                component={Link}
                href={navigationHrefs?.[destination.key] ?? destination.href}
              >
                {destination.label}
              </MenuItem>
            ))}
            <MenuDivider />
          </>
        )}
        <MenuLabel>Preferences</MenuLabel>
        <div className="queue-utility-menu__control">
          <ThemeToggle />
        </div>
        <InboxNotificationsToggle />
        <MenuDivider />
        <MenuLabel>Console</MenuLabel>
        <MenuIdentity />
        <div className="queue-utility-menu__control">{signOutControl}</div>
        <Anchor
          href={repositoryUrl}
          target="_blank"
          rel="noreferrer"
          size="xs"
          c="dimmed"
          className="queue-utility-menu__control"
        >
          Open repository on GitHub ↗
        </Anchor>
      </DeferredMenu>
      {itemActions.modal}
    </>
  );
}
