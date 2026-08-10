import { Center, Loader, Stack, Text } from '@mantine/core';

import { ConsoleAppShell } from './console-app-shell';

export default function Loading() {
  return (
    <ConsoleAppShell
      current="deck"
      title="Agent LCARS"
      subtitle="Loading console data…"
      streamingFallback
    >
      <Center py={100}>
        <Stack align="center" gap="sm">
          <Loader />
          <Text c="dimmed" size="sm">
            Loading agent activity from GitHub…
          </Text>
        </Stack>
      </Center>
    </ConsoleAppShell>
  );
}
