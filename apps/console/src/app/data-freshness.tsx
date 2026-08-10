'use client';

import { Text } from '@mantine/core';
import { useEffect, useState } from 'react';

import { formatRelativeTime } from './format';

/**
 * "Data as of Xm ago" for the pages that render cached GitHub reads (see
 * dashboard-data.ts's DASHBOARD_CACHE_LIFE - up to a minute stale by
 * design). The server passes the initial label so hydration matches, then
 * the client re-derives it every 30s, the same pattern refresh-button.tsx
 * uses for its own "Updated ..." label. Uncached Firestore reads are always
 * current, so callers feed this the oldest cached `fetchedAt` only.
 */
export function DataFreshness({
  fetchedAt,
  initialLabel,
  dataTestId = 'data-freshness',
}: {
  fetchedAt: string;
  initialLabel: string;
  dataTestId?: string;
}) {
  const [label, setLabel] = useState(initialLabel);

  useEffect(() => {
    const update = () => setLabel(formatRelativeTime(fetchedAt));
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, [fetchedAt]);

  return (
    <Text size="xs" c="dimmed" ta="right" data-testid={dataTestId}>
      Data as of <time dateTime={fetchedAt}>{label}</time>
    </Text>
  );
}
