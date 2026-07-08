'use client';

import { Button, Container, Group, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Agent Console error boundary caught:', error);
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
            Something went wrong
          </Title>
          <Text c="dimmed" size="lg" ta="center" maw={500}>
            The console hit an error rendering this page - likely a GitHub API
            hiccup. Try again, or check the server logs if it keeps happening.
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
            onClick={() => reset()}
          >
            Try again
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}
