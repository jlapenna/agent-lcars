'use client';

import { Button, CopyButton } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';

/**
 * The copy-to-clipboard takeover command chip, shared between
 * `ActionItemCard`'s full-weight card and the `/agents` page's compact rows
 * (claimed-idle items, active CLI sessions) - extracted from the original
 * `ActionItemCard`-only inline markup (#3024) so all three places render it
 * identically. Copy interactivity needs its own client boundary, same
 * pattern as `RefreshButton` elsewhere in this app.
 */
export function TakeoverCommand({ command }: { command: string }) {
  return (
    <CopyButton value={command} timeout={2_000}>
      {({ copied, copy }) => (
        <Button
          variant="light"
          size="compact-sm"
          color={copied ? 'teal' : 'gray'}
          leftSection={
            copied ? <IconCheck size={15} /> : <IconCopy size={15} />
          }
          onClick={copy}
          className="takeover-command-button"
        >
          {copied ? 'Takeover command copied' : 'Copy takeover command'}
        </Button>
      )}
    </CopyButton>
  );
}
