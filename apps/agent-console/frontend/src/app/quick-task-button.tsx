'use client';

import { Button, Popover, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useState, useTransition } from 'react';

import { createQuickTask } from './actions';

/**
 * Files a new `quick-task`-labeled issue from a free-text description and
 * hands it straight to the Claude issue agent (the `claude` label is added
 * as a follow-up call so the `issues: labeled` trigger actually fires - see
 * createQuickTask in backend-actions.ts). No polling here: the new issue
 * shows up in the board / In Flight panel on the next refresh.
 */
export function QuickTaskButton({ size = 'compact-sm' }: { size?: string }) {
  const [opened, setOpened] = useState(false);
  const [description, setDescription] = useState('');
  const [isPending, startTransition] = useTransition();

  const handleCreate = () => {
    const trimmed = description.trim();
    if (!trimmed) return;
    setOpened(false);
    startTransition(async () => {
      const result = await createQuickTask(trimmed);
      if (!result.ok) {
        notifications.show({ message: result.message, color: 'red' });
        return;
      }
      setDescription('');
      notifications.show({
        message: `Quick task filed as #${result.number}`,
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
          size={size}
          disabled={isPending}
          onClick={() => setOpened((prev) => !prev)}
        >
          Quick task
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            placeholder="Describe the task — this becomes the issue body, and its first line the title"
            autosize
            minRows={3}
          />
          <Button
            disabled={isPending || !description.trim()}
            onClick={handleCreate}
            fullWidth
          >
            File & dispatch
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
