import { Center, Loader, Stack, Text } from '@mantine/core';

import { ConsoleMessage } from './console-message';
import { withConsolePageShell } from './with-console-page-shell';

function LoadingContent() {
  return (
    <ConsoleMessage ariaLabel="Loading">
      <Center py={100}>
        <Stack align="center" gap="sm">
          <Loader />
          <Text c="dimmed" size="sm">
            Loading agent activity from GitHub…
          </Text>
        </Stack>
      </Center>
    </ConsoleMessage>
  );
}

export default withConsolePageShell(LoadingContent, {
  current: 'deck',
  title: 'Agent LCARS',
  subtitle: 'Loading console data…',
  streamingFallback: true,
});
