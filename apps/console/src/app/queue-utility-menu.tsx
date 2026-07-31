'use client';

import { ActionIcon, Anchor, Menu } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import type { ReactNode } from 'react';

import { ThemeToggle } from './theme-toggle';

const MOBILE_DESTINATIONS = [
  { href: '/', label: 'Queue' },
  { href: '/agents', label: 'Agents' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/costs', label: 'Costs' },
] as const;

export function QueueUtilityMenu({
  signOutControl,
  includeNavigation = false,
}: {
  signOutControl: ReactNode;
  includeNavigation?: boolean;
}) {
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          size={44}
          aria-label="More console options"
          className="queue-utility-trigger"
        >
          <IconDotsVertical aria-hidden="true" size={18} stroke={1.7} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown className="queue-utility-menu">
        {includeNavigation && (
          <>
            <Menu.Label>Navigate</Menu.Label>
            {MOBILE_DESTINATIONS.map((destination) => (
              <Menu.Item
                key={destination.href}
                component="a"
                href={destination.href}
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
          href="https://github.com/jlapenna/agent-lcars"
          target="_blank"
          rel="noreferrer"
          size="xs"
          c="dimmed"
          className="queue-utility-menu__control"
        >
          Open repository ↗
        </Anchor>
      </Menu.Dropdown>
    </Menu>
  );
}
