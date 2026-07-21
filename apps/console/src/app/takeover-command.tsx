'use client';

import {
  ActionIcon,
  Code,
  CopyButton,
  Group,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconLink } from '@tabler/icons-react';

/**
 * The copy-to-clipboard takeover command chip, shared between
 * `ActionItemCard`'s full-weight card and the `/agents` page's compact rows
 * (claimed-idle items, active CLI sessions) - extracted from the original
 * `ActionItemCard`-only inline markup (#3024) so all three places render it
 * identically. Copy interactivity needs its own client boundary, same
 * pattern as `CancelRunButton`/`RefreshButton` elsewhere in this app.
 */
export function TakeoverCommand({ command }: { command: string }) {
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
        Takeover:
      </Text>
      <Code style={{ overflowX: 'auto', whiteSpace: 'nowrap', minWidth: 0 }}>
        {command}
      </Code>
      <CopyButton value={command}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? 'Copied' : 'Copy takeover command'}>
            <ActionIcon
              variant="subtle"
              size="sm"
              color={copied ? 'teal' : 'gray'}
              onClick={copy}
              aria-label="Copy takeover command"
              style={{ flexShrink: 0 }}
            >
              {copied ? <IconCheck size={14} /> : <IconLink size={14} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}
