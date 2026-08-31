import { Group } from '@mantine/core';
import type { ReactNode } from 'react';

import { RefreshButton } from './refresh-button';
import { SignOutButton } from './sign-out-button';
import { ThemeToggle } from './theme-toggle';

// Bottom-of-page chrome shared by every console route. Time-sensitive
// controls live here so the header stays focused on identity and
// navigation - `actions` (the Quick task button) lives here too, rather
// than in each page's own header, so it sits in the same spot on every
// route including the session detail page's lighter back-link header (#235).
export function ConsoleFooter({
  generatedAt,
  refreshLabel,
  actions,
  refreshesAuthoritativeQueue = false,
}: {
  generatedAt?: string;
  refreshLabel?: string;
  actions?: ReactNode;
  /** Forwarded to RefreshButton - see its own doc. */
  refreshesAuthoritativeQueue?: boolean;
}) {
  return (
    <Group justify="center" mt="xl" gap="md">
      {actions}
      {generatedAt && refreshLabel && (
        <RefreshButton
          generatedAt={generatedAt}
          initialLabel={refreshLabel}
          refreshesAuthoritativeQueue={refreshesAuthoritativeQueue}
        />
      )}
      <ThemeToggle />
      <SignOutButton />
    </Group>
  );
}
