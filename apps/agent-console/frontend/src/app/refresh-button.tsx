'use client';

import { Button, Group, Text } from '@mantine/core';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

import { formatRelativeTime } from './format';

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
      <Button
        variant="subtle"
        size="compact-xs"
        loading={isPending}
        onClick={() => startTransition(() => router.refresh())}
      >
        Refresh
      </Button>
    </Group>
  );
}
