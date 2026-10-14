'use client';

import {
  UnstyledButton,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';

// A text control (not an icon) so it reads as a menu entry under the console
// menu's Preferences, away from the header's primary actions.
export function ThemeToggle() {
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
    <UnstyledButton onClick={toggleColorScheme} fz="xs" c="dimmed">
      {computedColorScheme === 'dark'
        ? 'Switch to light mode'
        : 'Switch to dark mode'}
    </UnstyledButton>
  );
}
