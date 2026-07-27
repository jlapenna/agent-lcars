import { Group } from '@mantine/core';
import type { ReactNode } from 'react';

import { RefreshButton } from './refresh-button';
import { SignOutButton } from './sign-out-button';
import { ThemeToggle } from './theme-toggle';

// Bottom-of-page chrome shared by every console route. Time-sensitive
// controls live here so the header stays focused on identity and navigation.
export function ConsoleFooter({
  generatedAt,
  refreshLabel,
}: {
  generatedAt?: string;
  refreshLabel?: string;
  actions?: ReactNode;
}) {
  return (
    <Group justify="center" mt="xl" gap="md">
      {generatedAt && refreshLabel && (
        <RefreshButton generatedAt={generatedAt} initialLabel={refreshLabel} />
      )}
      <ThemeToggle />
      <SignOutButton />
    </Group>
  );
}
