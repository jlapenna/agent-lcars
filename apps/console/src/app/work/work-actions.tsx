'use client';

import type { ItemState } from '@agent-lcars/work/derive';
import { Button, Checkbox, Group, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { showErrorToast } from '../show-error-toast';

/**
 * Deliberately looser than the exact `ProcedureServerFunction` type
 * `actions.ts` exports: this only needs the `[error, data]` tuple shape
 * (see `@orpc/next`'s `ServerFunctionResult`), not its precise error union,
 * so the real `cancelItem`/`redispatchItem` server functions (passed down
 * from a server component - a serializable reference, not the
 * component-as-prop trap) and a plain test double both satisfy it.
 */
export type WorkActionResult = readonly [
  { code: string; message: string } | null,
  unknown,
];
export type WorkAction = (input: { id: string }) => Promise<WorkActionResult>;
export type RedispatchAction = (input: {
  id: string;
  resumeSessionId?: string;
}) => Promise<WorkActionResult>;

/** The session offered as a resume target on redispatch: the latest
 *  session of the item's latest run. */
export interface ResumeCandidate {
  sessionId: string;
  title?: string;
}

export function WorkActions({
  id,
  state,
  cancel,
  redispatch,
  resumeCandidate,
}: {
  id: string;
  state: ItemState;
  cancel: WorkAction;
  redispatch: RedispatchAction;
  resumeCandidate?: ResumeCandidate;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [resumeChecked, setResumeChecked] = useState(true);

  const canCancel = state !== 'done' && state !== 'canceled';
  const canRedispatch = state === 'parked';

  if (!canCancel && !canRedispatch) return null;

  const runCancel = () => {
    startTransition(async () => {
      const [err] = await cancel({ id });
      if (err) {
        showErrorToast(err.message);
        return;
      }
      notifications.show({ message: 'Canceled', color: 'green' });
      router.refresh();
    });
  };

  const runRedispatch = () => {
    startTransition(async () => {
      const [err] = await redispatch({
        id,
        ...(resumeChecked &&
          resumeCandidate && { resumeSessionId: resumeCandidate.sessionId }),
      });
      if (err) {
        showErrorToast(err.message);
        return;
      }
      notifications.show({ message: 'Redispatched', color: 'green' });
      router.refresh();
    });
  };

  return (
    <Stack gap="xs">
      {canRedispatch && resumeCandidate && (
        <Checkbox
          checked={resumeChecked}
          onChange={(event) => setResumeChecked(event.currentTarget.checked)}
          label={`Resume from session ${resumeCandidate.sessionId} (${resumeCandidate.title ?? resumeCandidate.sessionId})`}
          size="sm"
        />
      )}
      <Group gap="xs">
        {canRedispatch && (
          <Button
            size="compact-sm"
            disabled={isPending}
            loading={isPending}
            onClick={runRedispatch}
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
            onClick={runCancel}
          >
            Cancel
          </Button>
        )}
      </Group>
    </Stack>
  );
}
