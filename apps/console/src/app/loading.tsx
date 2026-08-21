import { Center, Loader, Stack, Text } from '@mantine/core';

import { withConsolePageShell } from './with-console-page-shell';

function LoadingContent() {
  return (
    <Center py={100}>
      <Stack align="center" gap="sm">
        <Loader />
        <Text c="dimmed" size="sm">
          Loading agent activity from GitHub…
        </Text>
      </Stack>
    </Center>
  );
}

export default withConsolePageShell(LoadingContent, {
  current: 'deck',
  title: 'Agent LCARS',
  subtitle: 'Loading console data…',
  streamingFallback: true,
});
