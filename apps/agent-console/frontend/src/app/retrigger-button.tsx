'use client';

import { Button, Popover, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useState, useTransition } from 'react';

import { retriggerIssue } from './actions';

/**
 * Retrigger-with-steering-note, shared by queue cards and compact rows.
 * Only rendered for claude-labeled issues (the server 400s otherwise) and
 * disabled while a run is in flight (the label cycle would double-dispatch).
 */
export function RetriggerButton({
  issueNumber,
  disabled,
  disabledReason,
  onError,
  size = 'compact-sm',
}: {
  issueNumber: number;
  disabled?: boolean;
  disabledReason?: string;
  onError?: (message: string) => void;
  size?: string;
}) {
  const [opened, setOpened] = useState(false);
  const [note, setNote] = useState('');
  const [isPending, startTransition] = useTransition();

  const handleRetrigger = () => {
    setOpened(false);
    startTransition(async () => {
      const result = await retriggerIssue(
        issueNumber,
        note.trim() || undefined,
      );
      if (!result.ok) {
        onError?.(result.message);
        notifications.show({ message: result.message, color: 'red' });
        return;
      }
      setNote('');
      notifications.show({
        message: `#${issueNumber} retriggered`,
        color: 'green',
      });
    });
  };

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      width={340}
      position="bottom-end"
      withArrow
    >
      <Popover.Target>
        <Button
          variant="default"
          size={size}
          disabled={isPending || disabled}
          title={disabled ? disabledReason : undefined}
          onClick={() => setOpened((prev) => !prev)}
        >
          Retrigger
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            placeholder="Optional steering note — posted on the issue before the fresh run starts"
            autosize
            minRows={2}
          />
          <Button disabled={isPending} onClick={handleRetrigger} fullWidth>
            Retrigger now
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
