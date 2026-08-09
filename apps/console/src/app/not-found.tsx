import { Stack, Text, Title } from '@mantine/core';

import { ConsoleNavRail } from './console-header';
import { ConsolePageShell } from './console-page-shell';

/**
 * Styled 404 for the whole app - session detail and task pages call
 * notFound() for unknown ids, and Next's unstyled default gave no way
 * back into the console. The nav rail is the way back; "deck" is a
 * neutral current since the missing resource belongs to no section.
 */
export default function NotFound() {
  return (
    <ConsolePageShell>
      <Stack gap="xl">
        <ConsoleNavRail current="deck" />
        <Stack gap="xs" role="status">
          <Title order={1}>Not found</Title>
          <Text c="dimmed" size="sm" style={{ maxWidth: '36rem' }}>
            This session, task, or page doesn&rsquo;t exist — it may have been
            archived under a different id, or the link predates the current
            archive window. Pick a section above to get back to live data.
          </Text>
        </Stack>
      </Stack>
    </ConsolePageShell>
  );
}
