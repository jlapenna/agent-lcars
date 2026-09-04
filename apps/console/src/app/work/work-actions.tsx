'use client';

import type { ItemState } from '@agent-lcars/work/derive';
import { Button, Group, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { showErrorToast } from '../show-error-toast';

/**
 * Deliberately looser than the exact `ProcedureServerFunction` type
 * `actions.ts` exports: this only needs the `[error, data]` tuple shape
 * (see `@orpc/next`'s `ServerFunctionResult`), not its precise error union,
 * so the real `cancelItem`/`redispatchItem`/`replyToWorkItem` server
 * functions (passed down from a server component - a serializable
 * reference, not the component-as-prop trap) and a plain test double both
 * satisfy it.
 */
export type WorkActionResult = readonly [
  { code: string; message: string } | null,
  unknown,
];
export type WorkAction = (input: { id: string }) => Promise<WorkActionResult>;
export type RedispatchAction = (input: {
  id: string;
}) => Promise<WorkActionResult>;
export type ReplyActionResult = readonly [
  { code: string; message: string } | null,
  { resumed: boolean } | undefined,
];
export type ReplyAction = (input: {
  id: string;
  text: string;
}) => Promise<ReplyActionResult>;

export function WorkActions({
  id,
  state,
  cancel,
  redispatch,
  reply,
}: {
  id: string;
  state: ItemState;
  cancel: WorkAction;
  redispatch: RedispatchAction;
  /** Optional: the dashboard's `ParkedWorkPanel` renders `WorkActions`
   *  without a reply channel (it has no per-item conversation view to
   *  return to) and keeps its existing Cancel/Redispatch-only behavior. */
  reply?: ReplyAction;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [replyText, setReplyText] = useState('');
  const [freshSessionNote, setFreshSessionNote] = useState(false);

  const canCancel = state !== 'done' && state !== 'canceled';
  const canRedispatch = state === 'parked';
  // A reply is new information for a stopped item: parked (the agent asked
  // a question) or done ("one more tweak" on a finished item is a reply,
  // not a new item -- spec decision 2).
  const canReply =
    (state === 'parked' || state === 'done') && reply !== undefined;

  if (!canCancel && !canRedispatch && !canReply) return null;

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
      const [err] = await redispatch({ id });
      if (err) {
        showErrorToast(err.message);
        return;
      }
      notifications.show({ message: 'Redispatched', color: 'green' });
      router.refresh();
    });
  };

  const runReply = () => {
    const text = replyText.trim();
    if (!text || reply === undefined) return;
    startTransition(async () => {
      const [err, result] = await reply({ id, text });
      if (err) {
        showErrorToast(err.message);
        return;
      }
      setFreshSessionNote(result?.resumed === false);
      setReplyText('');
      notifications.show({ message: 'Replied', color: 'green' });
      router.refresh();
    });
  };

  return (
    <Stack gap="xs">
      {canReply && (
        <Stack gap={4}>
          <Textarea
            value={replyText}
            onChange={(event) => setReplyText(event.currentTarget.value)}
            placeholder="Reply to the agent..."
            autosize
            minRows={2}
          />
          {freshSessionNote && (
            <Text size="xs" c="dimmed">
              started a fresh session — no resumable transcript
            </Text>
          )}
        </Stack>
      )}
      <Group gap="xs">
        {canReply && (
          <Button
            size="compact-sm"
            disabled={isPending || replyText.trim().length === 0}
            loading={isPending}
            onClick={runReply}
          >
            Reply
          </Button>
        )}
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
