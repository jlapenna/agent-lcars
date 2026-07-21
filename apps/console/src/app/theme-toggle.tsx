'use client';

import {
  ActionIcon,
  ActionIconProps,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { IconMoon, IconSun } from '@tabler/icons-react';

// Mirrors apps/members/frontend/src/components/ThemeToggle.tsx.
export function ThemeToggle(props: ActionIconProps) {
  const { setColorScheme } = useMantineColorScheme();
  const computedColorScheme = useComputedColorScheme('light', {
    getInitialValueInEffect: true,
  });

  const toggleColorScheme = () => {
    const nextColorScheme = computedColorScheme === 'light' ? 'dark' : 'light';
    setColorScheme(nextColorScheme);
    // Set cookie for SSR
    document.cookie = `mantine-color-scheme=${nextColorScheme}; path=/; max-age=31536000`;
  };

  return (
    <Tooltip label="Toggle color scheme">
      <ActionIcon
        onClick={toggleColorScheme}
        variant="default"
        size="xl"
        radius="md"
        aria-label="Toggle color scheme"
        {...props}
      >
        {computedColorScheme === 'dark' ? (
          <IconSun
            aria-hidden="true"
            style={{ width: '70%', height: '70%' }}
            stroke={1.5}
          />
        ) : (
          <IconMoon
            aria-hidden="true"
            style={{ width: '70%', height: '70%' }}
            stroke={1.5}
          />
        )}
      </ActionIcon>
    </Tooltip>
  );
}
