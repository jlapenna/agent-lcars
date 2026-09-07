import { Stack, Text } from '@mantine/core';

import { ConsoleMessage } from './console-message';
import { withConsolePageShell } from './with-console-page-shell';

/**
 * Styled 404 for the whole app - session detail and task pages call
 * notFound() for unknown ids, and Next's unstyled default gave no way
 * back into the console. The nav rail is the way back; "deck" is a
 * neutral current since the missing resource belongs to no section.
 */
function NotFoundContent() {
  return (
    <ConsoleMessage ariaLabel="Not found">
      <Stack gap="xs" role="status">
        <Text c="dimmed" size="sm" style={{ maxWidth: '36rem' }}>
          This session, task, or page doesn&rsquo;t exist — it may have been
          archived under a different id, or the link predates the current
          archive window. Pick a section above to get back to live data.
        </Text>
      </Stack>
    </ConsoleMessage>
  );
}

export default withConsolePageShell(NotFoundContent, {
  current: 'deck',
  title: 'Not found',
  subtitle: 'The requested console resource is unavailable.',
});
