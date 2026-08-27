'use client';

import { Button, Group } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { showErrorToast } from '../../show-error-toast';

type ScheduleActionResult = readonly [
  { code: string; message: string } | null,
  unknown,
];
export type ScheduleAction = (input: {
  id: string;
}) => Promise<ScheduleActionResult>;

export function ScheduleActions({
  id,
  enabled,
  enable,
  disable,
}: {
  id: string;
  enabled: boolean;
  enable: ScheduleAction;
  disable: ScheduleAction;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const run = (action: ScheduleAction, successMessage: string) => {
    startTransition(async () => {
      const [err] = await action({ id });
      if (err) {
        showErrorToast(err.message);
        return;
      }
      notifications.show({ message: successMessage, color: 'green' });
      router.refresh();
    });
  };

  return (
    <Group gap="xs">
      {enabled ? (
        <Button
          variant="subtle"
          color="red"
          size="compact-sm"
          disabled={isPending}
          loading={isPending}
          onClick={() => run(disable, 'Disabled')}
        >
          Disable
        </Button>
      ) : (
        <Button
          size="compact-sm"
          disabled={isPending}
          loading={isPending}
          onClick={() => run(enable, 'Enabled')}
        >
          Enable
        </Button>
      )}
    </Group>
  );
}
