'use client';

import { Button, Popover, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useState, useTransition } from 'react';

import type { WatchedRepo } from '../lib/watched-repo';
import { retriggerIssue } from './actions';
import { createRandomId } from './random-id';
import { showErrorToast } from './show-error-toast';

/**
 * Retrigger-with-steering-note, shared by queue cards and compact rows.
 * Only rendered for claude- or opencode-labeled issues (the server 400s
 * otherwise) and disabled while a run is in flight. The dispatch pipeline
 * itself is no longer a caller-supplied prop (#1183): the orchestrator
 * derives it from the task's own run history, so this component only needs
 * to know which issue to retry.
 */
export function RetriggerButton({
  repo,
  issueNumber,
  disabled,
  disabledReason,
  onError,
  size = 'compact-sm',
}: {
  repo: WatchedRepo;
  issueNumber: number;
  disabled?: boolean;
  disabledReason?: string;
  onError?: (message: string) => void;
  size?: string;
}) {
  const [opened, setOpened] = useState(false);
  const [note, setNote] = useState('');
  const [isPending, startTransition] = useTransition();

  const handleRetrigger = () => {
    setOpened(false);
    startTransition(async () => {
      const result = await retriggerIssue(
        repo,
        issueNumber,
        createRandomId(),
        note.trim() || undefined,
      );
      if (!result.ok) {
        onError?.(result.message);
        showErrorToast(result.message);
        return;
      }
      setNote('');
      notifications.show({
        message: result.note
          ? `#${issueNumber} retriggered — ${result.note}`
          : `#${issueNumber} retriggered`,
        color: 'green',
      });
    });
  };

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      width={340}
      position="bottom-end"
      withArrow
    >
      <Popover.Target>
        <Button
          variant="default"
          size={size}
          disabled={isPending || disabled}
          loading={isPending}
          title={disabled ? disabledReason : undefined}
          onClick={() => setOpened((prev) => !prev)}
        >
          Retrigger
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            aria-label="Optional steering note — posted on the issue before the fresh run starts"
            placeholder="Optional steering note — posted on the issue before the fresh run starts"
            autosize
            minRows={2}
          />
          <Button
            disabled={isPending}
            loading={isPending}
            onClick={handleRetrigger}
            fullWidth
          >
            Retrigger now
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
