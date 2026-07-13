'use client';

import { Button, Popover, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useState, useTransition } from 'react';

import { dispatchUnstickPrs } from './actions';

/**
 * Dispatches playbook-unstick-prs.yml, which finds/creates an anchor issue
 * and hands it to the Claude issue agent with the unstick-prs runbook. The
 * console joins the resulting run to its own card via the run-name's
 * leading "#N:" prefix, so no polling is needed here beyond a refresh.
 */
export function UnstickPrsButton({ size = 'compact-sm' }: { size?: string }) {
  const [opened, setOpened] = useState(false);
  const [context, setContext] = useState('');
  const [isPending, startTransition] = useTransition();

  const handleDispatch = () => {
    setOpened(false);
    startTransition(async () => {
      const result = await dispatchUnstickPrs(context.trim() || undefined);
      if (!result.ok) {
        notifications.show({ message: result.message, color: 'red' });
        return;
      }
      setContext('');
      notifications.show({
        message: 'unstick-prs playbook dispatched',
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
          disabled={isPending}
          onClick={() => setOpened((prev) => !prev)}
        >
          Run unstick-prs
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Textarea
            value={context}
            onChange={(e) => setContext(e.currentTarget.value)}
            placeholder="Optional context — PR numbers, symptoms — posted on the anchor issue"
            autosize
            minRows={2}
          />
          <Button disabled={isPending} onClick={handleDispatch} fullWidth>
            Dispatch
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
