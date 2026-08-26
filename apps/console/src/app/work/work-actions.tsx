'use client';

import type { ItemState } from '@agent-lcars/work/derive';
import { Button, Group } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { showErrorToast } from '../show-error-toast';

/**
 * Deliberately looser than the exact `ProcedureServerFunction` type
 * `functions.ts` exports: this only needs the `[error, data]` tuple shape
 * (see `@orpc/next`'s `ServerFunctionResult`), not its precise error union,
 * so the real `cancelItem`/`redispatchItem` server functions (passed down
 * from a server component - a serializable reference, not the
 * component-as-prop trap) and a plain test double both satisfy it.
 */
type WorkActionResult = readonly [
  { code: string; message: string } | null,
  unknown,
];
type WorkAction = (input: { id: string }) => Promise<WorkActionResult>;

export function WorkActions({
  id,
  state,
  cancel,
  redispatch,
}: {
  id: string;
  state: ItemState;
  cancel: WorkAction;
  redispatch: WorkAction;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const canCancel = state !== 'done' && state !== 'canceled';
  const canRedispatch = state === 'parked';

  if (!canCancel && !canRedispatch) return null;

  const run = (action: WorkAction, successMessage: string) => {
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
      {canRedispatch && (
        <Button
          size="compact-sm"
          disabled={isPending}
          loading={isPending}
          onClick={() => run(redispatch, 'Redispatched')}
        >
          Redispatch
        </Button>
      )}
      {canCancel && (
        <Button
          variant="subtle"
          color="red"
          size="compact-sm"
          disabled={isPending}
          loading={isPending}
          onClick={() => run(cancel, 'Canceled')}
        >
          Cancel
        </Button>
      )}
    </Group>
  );
}
