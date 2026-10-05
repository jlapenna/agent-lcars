'use client';

import { WORK_DESCRIPTION_MAX, WORK_TITLE_MAX } from '@agent-lcars/work';
import { Button, Group, Stack, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { showErrorToast } from '../show-error-toast';

export type UpdateActionResult = readonly [
  { code: string; message: string } | null,
  unknown,
];
export type UpdateAction = (input: {
  id: string;
  title: string;
  description: string;
}) => Promise<UpdateActionResult>;

/** Edits an item's title and description. Hidden while a run is live: the
 *  worker already holds the description it was dispatched with. */
export function EditWork({
  id,
  title,
  description,
  running,
  update,
}: {
  id: string;
  title: string;
  description: string;
  running: boolean;
  update: UpdateAction;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftDescription, setDraftDescription] = useState(description);

  if (running) return null;

  if (!editing) {
    return (
      <Group>
        <Button
          variant="default"
          size="compact-sm"
          onClick={() => {
            setDraftTitle(title);
            setDraftDescription(description);
            setEditing(true);
          }}
        >
          Edit
        </Button>
      </Group>
    );
  }

  const nextTitle = draftTitle.trim();
  const nextDescription = draftDescription.trim();
  const unchanged = nextTitle === title && nextDescription === description;
  const invalid =
    nextTitle.length === 0 ||
    nextTitle.length > WORK_TITLE_MAX ||
    nextDescription.length === 0 ||
    nextDescription.length > WORK_DESCRIPTION_MAX;

  const save = () => {
    startTransition(async () => {
      const [err] = await update({
        id,
        title: nextTitle,
        description: nextDescription,
      });
      if (err) {
        showErrorToast(err.message);
        return;
      }
      notifications.show({ message: 'Saved', color: 'green' });
      setEditing(false);
      router.refresh();
    });
  };

  return (
    <Stack gap="xs">
      <TextInput
        label="Title"
        value={draftTitle}
        maxLength={WORK_TITLE_MAX}
        onChange={(event) => setDraftTitle(event.currentTarget.value)}
      />
      <Textarea
        label="Description"
        value={draftDescription}
        maxLength={WORK_DESCRIPTION_MAX}
        autosize
        minRows={4}
        onChange={(event) => setDraftDescription(event.currentTarget.value)}
      />
      <Group gap="xs">
        <Button
          size="compact-sm"
          disabled={isPending || invalid || unchanged}
          loading={isPending}
          onClick={save}
        >
          Save
        </Button>
        <Button
          variant="subtle"
          size="compact-sm"
          disabled={isPending}
          onClick={() => setEditing(false)}
        >
          Cancel edit
        </Button>
      </Group>
    </Stack>
  );
}
