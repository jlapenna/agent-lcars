'use client';

import { Button, Select, Stack, Text, Textarea } from '@mantine/core';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import type { ActionItem } from '../../lib/action-items';
import type { Pipeline } from '../../lib/primary-action';
import {
  matchingAgentPipelines,
  selectedReplyPipeline,
  supportedAgentPipelines,
} from '../../lib/watched-repo';
import { replyToItem } from '../actions';

/** Uses GitHub's existing authenticated reply/admission path. Never adapts
 * a GitHub task key into a native Work mutation. */
export function GithubDetailReply({ item }: { item: ActionItem }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<Pipeline>();
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string }>();
  const [pending, startTransition] = useTransition();
  const assigned = selectedReplyPipeline(item.repo, item.labels, item.kind);
  const targets =
    assigned === undefined &&
    item.kind === 'issue' &&
    matchingAgentPipelines(item.repo, item.labels).length === 0
      ? supportedAgentPipelines(item.repo)
      : [];
  return (
    <Stack gap="xs">
      {targets.length > 0 && (
        <Select
          label="Reply, handing off to"
          value={chosen ?? ''}
          data={[
            { value: '', label: 'Comment only' },
            ...targets.map((value) => ({ value, label: value })),
          ]}
          onChange={(value) =>
            setChosen(targets.find((target) => target === value))
          }
          disabled={pending}
        />
      )}
      <Textarea
        label="Reply to the agent"
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        autosize
        minRows={2}
        disabled={pending}
      />
      <Button
        size="compact-sm"
        disabled={pending || !text.trim()}
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await replyToItem(
              item.repo,
              item.number,
              text.trim(),
              assigned ?? chosen,
            );
            setFeedback({
              ok: result.ok,
              message: result.ok ? result.note : result.message,
            });
            if (result.ok) {
              setText('');
              router.refresh();
            }
          })
        }
      >
        Reply
      </Button>
      {feedback && (
        <Text role={feedback.ok ? 'status' : 'alert'} size="sm">
          {feedback.message}
        </Text>
      )}
    </Stack>
  );
}
