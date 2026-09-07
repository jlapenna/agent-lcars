import { Group } from '@mantine/core';

import { RefreshButton } from './refresh-button';
import { SignOutButton } from './sign-out-button';
import { ThemeToggle } from './theme-toggle';

// Bottom-of-page chrome shared by every console route. Time-sensitive
// controls live here so the header stays focused on identity and
// navigation. The Quick task button used to live here too (#235), but that
// put it in a different spot than the header-hosted button every other
// route uses; it now sits in each route's own header utilities instead, so
// its position no longer depends on which page you're on (#1810).
export function ConsoleFooter({
  generatedAt,
  refreshLabel,
  refreshesAuthoritativeQueue = false,
}: {
  generatedAt?: string;
  refreshLabel?: string;
  /** Forwarded to RefreshButton - see its own doc. */
  refreshesAuthoritativeQueue?: boolean;
}) {
  return (
    <Group justify="center" mt="xl" gap="md">
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
