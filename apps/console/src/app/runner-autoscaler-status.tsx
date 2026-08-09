'use client';

import { Badge, Group, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';

import type {
  AutoscalerScaleSetStatus,
  AutoscalerStatusResult,
} from '../lib/autoscaler-status';
import { Eyebrow } from './eyebrow';

const POLL_INTERVAL_MS = 10_000;

function ScaleSetRow({ status }: { status: AutoscalerScaleSetStatus }) {
  const busy = status.runners.filter((runner) => runner.state === 'busy');
  const idle = status.runners.length - busy.length;
  return (
    <Stack gap={2} data-testid={`autoscaler-scale-set-${status.scaleSet}`}>
      <Group gap="xs" wrap="wrap">
        <Text size="sm" fw={500}>
          {status.scaleSet}
        </Text>
        {status.draining && (
          <Badge color="yellow" size="xs">
            draining
          </Badge>
        )}
        <Text size="xs" c="dimmed">
          {status.queuedJobs} queued · {busy.length} busy · {idle} idle ·{' '}
          {status.maxRunners} max
        </Text>
      </Group>
      {busy.length > 0 && (
        <Text size="xs" c="dimmed">
          jobs:{' '}
          {busy
            .map(
              (runner) =>
                `${runner.name}${runner.jobId ? ` (${runner.jobId})` : ''}`,
            )
            .join(', ')}
        </Text>
      )}
    </Stack>
  );
}

/** A tiny, isolated polling island: status refreshes every 10 seconds without
 * re-running the dashboard's GitHub reads or invalidating its cache. */
export function RunnerAutoscalerStatus({
  initial,
}: {
  initial: AutoscalerStatusResult;
}) {
  const [result, setResult] = useState(initial);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch('/api/runner-status', {
          cache: 'no-store',
        });
        if (!response.ok) return;
        const next = (await response.json()) as AutoscalerStatusResult;
        if (active) setResult(next);
      } catch {
        // Keep the last known snapshot; the next poll can recover.
      }
    };
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  if (result.statuses.length === 0) {
    return result.warnings.length > 0 ? (
      <Text size="xs" c="dimmed" data-testid="runner-autoscaler-status-warning">
        {result.warnings[0]}
      </Text>
    ) : null;
  }
  return (
    <Stack gap="xs" data-testid="runner-autoscaler-status">
      <Eyebrow>Runner autoscaler</Eyebrow>
      {result.statuses.map((status) => (
        <ScaleSetRow key={status.scaleSet} status={status} />
      ))}
    </Stack>
  );
}
