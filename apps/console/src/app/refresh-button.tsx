'use client';

import { Button, Group, Text } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

import { formatRelativeTime } from './format';
import { refreshDashboard } from './refresh-action';

export function RefreshButton({
  generatedAt,
  initialLabel,
  refreshesAuthoritativeQueue = false,
  compact = false,
}: {
  generatedAt?: string;
  initialLabel?: string;
  /** Whether this route renders the cached authoritative queue (see
   * lib/dashboard-data.ts). Invalidating its tag before an unrelated detail
   * refresh would force the next queue visit to repeat projection reads for
   * state that did not change. */
  refreshesAuthoritativeQueue?: boolean;
  /** Icon-only command-rail treatment. Mobile CSS still gives it a 44px
   * target even though the visual icon remains compact. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [label, setLabel] = useState(initialLabel ?? '');
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!generatedAt) return;
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
      {generatedAt && (
        <Text size="xs" c="dimmed">
          Updated {label}
        </Text>
      )}
      <Button
        variant="default"
        size="compact-sm"
        className="lcars-refresh-button"
        data-compact={compact ? '' : undefined}
        loading={isPending}
        aria-label="Refresh"
        leftSection={<IconRefresh aria-hidden="true" size={16} stroke={1.5} />}
        onClick={() =>
          startTransition(async () => {
            if (refreshesAuthoritativeQueue) await refreshDashboard();
            router.refresh();
          })
        }
      >
        {/* The mockup's text control; narrow headers keep the icon only. */}
        <span className="lcars-refresh-button__label">Refresh</span>
      </Button>
    </Group>
  );
}
