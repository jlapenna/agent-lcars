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
  bustsGithubCache = false,
  compact = false,
}: {
  generatedAt?: string;
  initialLabel?: string;
  /** Whether this page renders cached GitHub data (see
   * lib/dashboard-data.ts). Only Deck, Inbox, and Agents do; the session
   * pages read Firestore/GCS, and busting the GitHub tag from there would
   * force the next data-heavy visit to repeat ~30 requests for state that never
   * changed. */
  bustsGithubCache?: boolean;
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
      <Tooltip label="Refresh">
        <ActionIcon
          variant="subtle"
          size={compact ? 44 : 'sm'}
          className="lcars-refresh-button"
          loading={isPending}
          aria-label="Refresh"
          onClick={() =>
            startTransition(async () => {
              // Drop the cached GitHub read first, then re-render against
              // the fresh one - see refreshDashboard's own comment.
              if (bustsGithubCache) await refreshDashboard();
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
