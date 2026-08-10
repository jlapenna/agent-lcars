'use client';

import { Button, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { unstable_isUnrecognizedActionError } from 'next/navigation';
import { useEffect } from 'react';

import { ConsoleAppShell } from './console-app-shell';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isStaleDeploy = unstable_isUnrecognizedActionError(error);

  useEffect(() => {
    console.error('Agent LCARS error boundary caught:', error);
  }, [error]);

  return (
    <ConsoleAppShell
      current="deck"
      title={isStaleDeploy ? 'Console was updated' : 'Something went wrong'}
      subtitle="The current console view is temporarily unavailable."
    >
      <Stack align="center" gap="xl">
        <IconAlertTriangle
          aria-hidden="true"
          size={64}
          color="var(--mantine-color-red-6)"
        />
        <Stack align="center" gap="xs">
          <Text c="dimmed" size="lg" ta="center" maw={500}>
            {isStaleDeploy
              ? 'The console was redeployed under this tab. Reload the page to pick up the latest version.'
              : 'The console hit an error rendering this page - likely a GitHub API hiccup. Try again, or check the server logs if it keeps happening.'}
          </Text>
        </Stack>

        {error.digest && (
          <Text size="xs" c="dimmed" ff="monospace">
            Error ID: {error.digest}
          </Text>
        )}

        <Group>
          <Button
            variant="filled"
            leftSection={<IconRefresh aria-hidden="true" size={20} />}
            onClick={() => (isStaleDeploy ? window.location.reload() : reset())}
          >
            {isStaleDeploy ? 'Reload page' : 'Try again'}
          </Button>
        </Group>
      </Stack>
    </ConsoleAppShell>
  );
}
