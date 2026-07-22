'use client';

import { Button, Container, Group, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { unstable_isUnrecognizedActionError } from 'next/navigation';
import { useEffect } from 'react';

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
    <Container size="sm" py={100}>
      <Stack align="center" gap="xl">
        <IconAlertTriangle
          aria-hidden="true"
          size={64}
          color="var(--mantine-color-red-6)"
        />
        <Stack align="center" gap="xs">
          <Title order={1} ta="center">
            {isStaleDeploy ? 'Console was updated' : 'Something went wrong'}
          </Title>
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
    </Container>
  );
}
