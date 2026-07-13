'use client';

import { Button, Checkbox, Popover, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useState, useTransition } from 'react';

import { evictNxCache } from './actions';

/**
 * Dispatches playbook-evict-nx-cache.yml, the one unstick-prs mitigation
 * the issue agent cannot do itself (needs host exec on spark). Deliberately
 * human-triggered, not automatic — only for confirmed cache corruption
 * (stale/failed tarball reads), never a genuine test/UI regression.
 */
export function EvictNxCacheButton({ size = 'compact-sm' }: { size?: string }) {
  const [opened, setOpened] = useState(false);
  const [capture, setCapture] = useState(false);
  const [isPending, startTransition] = useTransition();

  const handleEvict = () => {
    setOpened(false);
    startTransition(async () => {
      const result = await evictNxCache(capture);
      if (!result.ok) {
        notifications.show({ message: result.message, color: 'red' });
        return;
      }
      setCapture(false);
      notifications.show({
        message: 'nx cache eviction dispatched',
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
          color="red"
          size={size}
          disabled={isPending}
          onClick={() => setOpened((prev) => !prev)}
        >
          Evict nx cache
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text size="sm">
            Deletes everything under /data on spark&apos;s nx-cache-server.
            Every CI/e2e run pays a full cold cache afterward — only for
            confirmed corruption, not a genuine regression.
          </Text>
          <Checkbox
            label="Capture the cache first (for root-causing corruption)"
            checked={capture}
            onChange={(e) => setCapture(e.currentTarget.checked)}
          />
          <Button
            color="red"
            disabled={isPending}
            onClick={handleEvict}
            fullWidth
          >
            Evict now
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
