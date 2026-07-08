'use client';

import { Button, ButtonProps } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useTransition } from 'react';

import { cancelRun } from './actions';

export function CancelRunButton({
  runId,
  label,
  ...buttonProps
}: {
  runId: number;
  /** Short description of the run, shown in the confirm dialog. */
  label: string;
} & ButtonProps) {
  const [isPending, startTransition] = useTransition();

  const handleCancel = () => {
    startTransition(async () => {
      try {
        await cancelRun(runId);
        notifications.show({ message: 'Run cancelled', color: 'green' });
      } catch (e) {
        notifications.show({
          message: e instanceof Error ? e.message : 'Failed to cancel run',
          color: 'red',
        });
      }
    });
  };

  const confirmCancel = () =>
    modals.openConfirmModal({
      title: 'Cancel this run?',
      children: `This stops the in-flight agent run for "${label}". It can pick the item back up on the next retrigger.`,
      labels: { confirm: 'Cancel run', cancel: 'Keep running' },
      confirmProps: { color: 'red' },
      onConfirm: handleCancel,
    });

  return (
    <Button
      variant="subtle"
      color="red"
      size="compact-xs"
      disabled={isPending}
      onClick={confirmCancel}
      {...buttonProps}
    >
      Cancel run
    </Button>
  );
}
