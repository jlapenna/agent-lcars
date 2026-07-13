'use client';

import { Button, Modal, Stack, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useState, useTransition } from 'react';

import { createQuickTask } from './actions';

/**
 * Files a new `quick-task`-labeled issue from a free-text description and
 * hands it straight to the Claude issue agent (the `claude` label is added
 * as a follow-up call so the `issues: labeled` trigger actually fires - see
 * createQuickTask in backend-actions.ts). No polling here: the new issue
 * shows up in the board / In Flight panel on the next refresh.
 *
 * Full screen rather than a Popover: an autosizing Popover grows and shifts
 * position as its content grows, so pasting a long description made the
 * whole dropdown jump around under the cursor - see #2773.
 */
export function QuickTaskButton({ size = 'compact-sm' }: { size?: string }) {
  const [opened, setOpened] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPending, startTransition] = useTransition();

  const close = () => setOpened(false);

  const handleCreate = () => {
    const trimmed = description.trim();
    if (!trimmed) return;
    close();
    startTransition(async () => {
      const result = await createQuickTask(trimmed, title.trim());
      if (!result.ok) {
        notifications.show({ message: result.message, color: 'red' });
        return;
      }
      setTitle('');
      setDescription('');
      notifications.show({
        message: `Quick task filed as #${result.number}`,
        color: 'green',
      });
    });
  };

  return (
    <>
      <Button size={size} disabled={isPending} onClick={() => setOpened(true)}>
        Quick task
      </Button>
      <Modal
        opened={opened}
        onClose={close}
        fullScreen
        title="File a quick task"
      >
        <Stack gap="sm">
          <TextInput
            label="Title"
            description="Optional — defaults to the first line of the description"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            placeholder="Short summary for the issue title"
          />
          <Textarea
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            placeholder="Describe the task — this becomes the issue body"
            autosize
            minRows={12}
          />
          <Button
            disabled={isPending || !description.trim()}
            onClick={handleCreate}
          >
            File & dispatch
          </Button>
        </Stack>
      </Modal>
    </>
  );
}
