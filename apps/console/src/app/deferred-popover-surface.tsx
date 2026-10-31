'use client';

import { Menu, Popover } from '@mantine/core';
import { useEffect, useState } from 'react';

import type { DeferredSurfaceProps } from './deferred-surface-props';

export function DeferredPopoverSurface({
  kind,
  target,
  children,
  dropdownClassName,
  focusOnMount,
  opened,
  ...props
}: DeferredSurfaceProps) {
  // Mantine captures return focus on a closed -> open transition, after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // The SSR button is replaced by Mantine's target when the chunk arrives.
  // Preserve focus only if that button still owned it, before the normal
  // Mantine focus trap/return hooks capture their target.
  const button = target({
    autoFocus: focusOnMount,
    ...(kind === 'popover' ? { onClick: () => props.onChange(!opened) } : {}),
    onKeyDown: (event) => {
      if (
        !event.defaultPrevented &&
        kind === 'menu' &&
        (event.key === 'ArrowDown' || event.key === 'ArrowUp')
      ) {
        event.preventDefault();
        props.onChange(true);
      }
    },
  });
  if (kind === 'menu')
    return (
      <Menu {...props} opened={mounted && opened} withinPortal>
        <Menu.Target>{button}</Menu.Target>
        <Menu.Dropdown className={dropdownClassName}>{children}</Menu.Dropdown>
      </Menu>
    );

  return (
    <Popover {...props} opened={mounted && opened}>
      <Popover.Target>{button}</Popover.Target>
      <Popover.Dropdown className={dropdownClassName}>
        {children}
      </Popover.Dropdown>
    </Popover>
  );
}
