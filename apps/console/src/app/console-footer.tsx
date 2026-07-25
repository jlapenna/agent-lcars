import { Group } from '@mantine/core';

import { ThemeToggle } from './theme-toggle';

// Bottom-of-page chrome shared by every console route - just the theme
// toggle, moved out of the header's top action row (issue #81).
export function ConsoleFooter() {
  return (
    <Group justify="center" mt="xl">
      <ThemeToggle />
    </Group>
  );
}
