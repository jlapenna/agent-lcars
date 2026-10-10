'use client';

import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

import { showErrorToast } from '../../show-error-toast';
import {
  type EditableSchedule,
  ScheduleCreateForm,
  type UpdateScheduleAction,
} from './schedule-create-form';

type ScheduleActionResult = readonly [
  { code: string; message: string } | null,
  unknown,
];
export type ScheduleAction = (input: {
  id: string;
  expectedRevision: number;
}) => Promise<ScheduleActionResult>;

export function ScheduleActions({
  schedule,
  enable,
  disable,
  update,
  remove,
}: {
  schedule: EditableSchedule;
  enable: ScheduleAction;
  disable: ScheduleAction;
  update: UpdateScheduleAction;
  remove: ScheduleAction;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Streamed markup can appear before its event handlers. Do not accept a
  // first click that cannot yet open the dialog or execute the mutation.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  // Freeze the selected revision while the dialog is open. A refreshed row
  // cannot silently approve deletion/editing of a different configuration.
  const [editPending, setEditPending] = useState(false);
  const busy = !ready || isPending || editPending;
  const [editing, setEditing] = useState<EditableSchedule>();
  const [deleting, setDeleting] = useState<EditableSchedule>();
  const [error, setError] = useState<string>();
  const run = (
    action: ScheduleAction,
    selected: EditableSchedule,
    message: string,
  ) => {
    startTransition(async () => {
      setError(undefined);
      try {
        const [err] = await action({
          id: selected.id,
          expectedRevision: selected.revision,
        });
        if (err) {
          setError(err.message);
          showErrorToast(err.message);
          return;
        }
        setDeleting(undefined);
        notifications.show({ message, color: 'green' });
        router.refresh();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Could not change schedule. Please retry.';
        setError(message);
        showErrorToast(message);
      }
    });
  };
  return (
    <>
      <Stack gap={2}>
        <Group gap="xs">
          <Button
            variant="subtle"
            size="compact-sm"
            disabled={busy}
            onClick={() => {
              setError(undefined);
              setEditing(structuredClone(schedule));
            }}
          >
            Edit
          </Button>
          <Button
            variant="subtle"
            color={schedule.enabled ? 'red' : undefined}
            size="compact-sm"
            disabled={busy}
            loading={isPending}
            onClick={() =>
              run(
                schedule.enabled ? disable : enable,
                schedule,
                schedule.enabled ? 'Disabled' : 'Enabled',
              )
            }
          >
            {schedule.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            variant="subtle"
            color="red"
            size="compact-sm"
            disabled={busy}
            onClick={() => {
              setError(undefined);
              setDeleting(structuredClone(schedule));
            }}
          >
            Delete
          </Button>
        </Group>
        {error && (
          <Text role="alert" c="red" size="xs">
            {error}
          </Text>
        )}
      </Stack>
      <Modal
        opened={editing !== undefined}
        onClose={() => {
          if (!editPending) setEditing(undefined);
        }}
        closeOnClickOutside={!editPending}
        closeOnEscape={!editPending}
        withCloseButton={!editPending}
        title="Edit schedule"
      >
        {editing && (
          <ScheduleCreateForm
            key={`${editing.id}:${editing.revision}`}
            initial={editing}
            onPendingChange={setEditPending}
            defaultRepo={editing.spec?.target.repo ?? ''}
            create={(input) =>
              update({
                ...input,
                id: editing.id,
                expectedRevision: editing.revision,
              })
            }
            onSaved={() => {
              setEditing(undefined);
              router.refresh();
            }}
          />
        )}
      </Modal>
      <Modal
        opened={deleting !== undefined}
        onClose={() => {
          if (!isPending) setDeleting(undefined);
        }}
        closeOnClickOutside={!isPending}
        closeOnEscape={!isPending}
        withCloseButton={!isPending}
        title="Delete schedule?"
      >
        <Stack gap="sm">
          <Text>
            Delete {deleting?.spec?.title ?? 'this schedule'}? Future
            occurrences stop. An already admitted occurrence may still finish.
          </Text>
          {error && (
            <Text role="alert" c="red">
              {error}
            </Text>
          )}
          <Group justify="flex-end">
            <Button
              variant="subtle"
              disabled={busy}
              onClick={() => setDeleting(undefined)}
            >
              Cancel
            </Button>
            <Button
              color="red"
              loading={isPending}
              disabled={busy}
              onClick={() =>
                deleting && run(remove, deleting, 'Schedule deleted')
              }
            >
              Delete schedule
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
