'use client';

import { ActionIcon, Group, Text, Tooltip } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

import { formatRelativeTime } from './format';
import { refreshDashboard } from './refresh-action';

export function RefreshButton({
  generatedAt,
  initialLabel,
}: {
  generatedAt: string;
  initialLabel: string;
}) {
  const router = useRouter();
  const [label, setLabel] = useState(initialLabel);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    // Resync immediately on a new generatedAt (e.g. right after a refresh) -
    // without this, the label kept showing the stale pre-refresh value until
    // the next 30s tick.
    setLabel(formatRelativeTime(generatedAt));
    const id = setInterval(
      () => setLabel(formatRelativeTime(generatedAt)),
      30_000,
    );
    return () => clearInterval(id);
  }, [generatedAt]);

  return (
    <Group gap="xs">
      <Text size="xs" c="dimmed">
        Updated {label}
      </Text>
      <Tooltip label="Refresh">
        <ActionIcon
          variant="subtle"
          size="sm"
          loading={isPending}
          aria-label="Refresh"
          onClick={() =>
            startTransition(async () => {
              // Drop the cached GitHub read first, then re-render against
              // the fresh one - see refreshDashboard's own comment.
              await refreshDashboard();
              router.refresh();
            })
          }
        >
          <IconRefresh aria-hidden="true" size={16} stroke={1.5} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
