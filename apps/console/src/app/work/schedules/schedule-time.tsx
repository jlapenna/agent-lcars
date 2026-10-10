'use client';

import { Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';

/** Evaluation remains UTC; local time is an explicitly labeled browser view. */
export function ScheduleTime({ value }: { value: string | undefined }) {
  const [local, setLocal] = useState<string>();
  useEffect(() => {
    if (value === undefined) {
      setLocal(undefined);
      return;
    }
    const formatter = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    setLocal(
      `Local (${formatter.resolvedOptions().timeZone}): ${formatter.format(new Date(value))}`,
    );
  }, [value]);
  if (value === undefined)
    return (
      <Text size="xs" c="dimmed">
        No next occurrence
      </Text>
    );
  return (
    <Stack gap={2}>
      <Text size="xs">
        <time dateTime={value}>UTC: {value}</time>
      </Text>
      {local && (
        <Text size="xs" c="dimmed">
          {local}
        </Text>
      )}
    </Stack>
  );
}
