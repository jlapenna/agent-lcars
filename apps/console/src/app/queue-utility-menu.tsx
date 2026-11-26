'use client';

import { ActionIcon, Anchor, Menu } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDotsVertical } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type MouseEvent, type ReactNode, useTransition } from 'react';

import type { ActionItem } from '../lib/action-items';
import { consoleDestinations, type NavKey } from './console-navigation';
import { useConsoleNavigationKeys } from './console-navigation-context';
import { useItemOverflowMenu } from './item-overflow-menu';

async function sharePage() {
  const permalink = window.location.href;
  try {
    await navigator.clipboard.writeText(permalink);
  } catch {
    window.prompt('Copy this page link', permalink);
    return;
  }
  notifications.show({ message: 'Page link copied' });
}

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
  const router = useRouter();
  // The menu closes, and unmounts its links, as soon as one is tapped, while
  // the current page stays on screen until the next one is ready. Running
  // the navigation in a transition lets the trigger show the wait instead.
  const [navigating, startNavigation] = useTransition();
  const navigate = (href: string) => (event: MouseEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    startNavigation(() => router.push(href));
  };

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          size={44}
          disabled={itemActions.isPending}
          loading={itemActions.isPending || navigating}
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
            {consoleDestinations(allowedKeys).map((destination) => {
              const href =
                navigationHrefs?.[destination.key] ?? destination.href;
              return (
                <Menu.Item
                  key={destination.key}
                  component={Link}
                  href={href}
                  onClick={navigate(href)}
                >
                  {destination.label}
                </Menu.Item>
              );
            })}
            <Menu.Divider />
          </>
        )}
        <Menu.Item onClick={sharePage}>Share</Menu.Item>
        <Menu.Item
          component={Link}
          href="/settings"
          onClick={navigate('/settings')}
        >
          Settings
        </Menu.Item>
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
      </Menu.Dropdown>
      {itemActions.modal}
    </Menu>
  );
}
