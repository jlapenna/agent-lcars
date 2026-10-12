'use client';

import { Button, Stack, Text } from '@mantine/core';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import type { WatchedRepo } from '../lib/github-client';
import { type ReplyResult, retryReplyToItem } from './actions';

type Retry = NonNullable<Extract<ReplyResult, { ok: true }>['retry']>;

export function RetryReplyDispatch({
  repo,
  number,
  retry,
  onDispatched,
}: {
  repo: WatchedRepo;
  number: number;
  retry: Retry;
  onDispatched?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string }>();
  return (
    <Stack gap="xs">
      {!feedback?.ok && (
        <Button
          size="compact-sm"
          variant="default"
          disabled={pending}
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await retryReplyToItem(
                repo,
                number,
                retry.commentId,
                retry.pipeline,
              );
              setFeedback({
                ok: result.ok,
                message: result.ok
                  ? (result.note ?? 'Agent dispatched')
                  : result.message,
              });
              if (result.ok) {
                onDispatched?.();
                router.refresh();
              }
            })
          }
        >
          Retry dispatch
        </Button>
      )}
      {feedback && (
        <Text role={feedback.ok ? 'status' : 'alert'} size="sm">
          {feedback.message}
        </Text>
      )}
    </Stack>
  );
}
