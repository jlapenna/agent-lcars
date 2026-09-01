'use client';

import { Button, Popover, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useState, useTransition } from 'react';

import { dispatchUnstickPrs } from './actions';
import { showErrorToast } from './show-error-toast';

/**
 * Finds or creates the repository's audit anchor, then admits the Claude
 * runbook through the Work API. GitHub stores the human-readable incident
 * thread; it is not an execution hop.
 *
 * `defaultContext` lets a queue card prefill "#N title" so a maintainer can
 * dispatch scoped to one stuck item in a single click instead of retyping
 * it into the header's blank popover.
 */
export function UnstickPrsButton({
  size = 'compact-sm',
  label = 'Run unstick-prs',
  defaultContext = '',
  repo,
}: {
  size?: string;
  label?: string;
  defaultContext?: string;
  /** Repository whose pull-request queue should be unstuck. */
  repo: { owner: string; name: string };
}) {
  const [opened, setOpened] = useState(false);
  const [context, setContext] = useState(defaultContext);
  const [isPending, startTransition] = useTransition();

  const handleDispatch = () => {
    setOpened(false);
    startTransition(async () => {
      const result = await dispatchUnstickPrs(
        context.trim() || undefined,
        repo,
      );
      if (!result.ok) {
        showErrorToast(result.message);
        return;
      }
      setContext(defaultContext);
      notifications.show({
        message: 'unstick-prs runbook dispatched',
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
          className="lcars-action-button"
          data-accent="violet"
          size={size}
          disabled={isPending}
          loading={isPending}
          onClick={() => setOpened((prev) => !prev)}
        >
          {label}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Textarea
            value={context}
            onChange={(e) => setContext(e.currentTarget.value)}
            aria-label="Optional context — PR numbers, symptoms — posted on the anchor issue"
            placeholder="Optional context — PR numbers, symptoms — posted on the anchor issue"
            autosize
            minRows={2}
          />
          <Button
            disabled={isPending}
            loading={isPending}
            onClick={handleDispatch}
            fullWidth
          >
            Dispatch
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
