'use client';

import { Anchor, Badge, Group, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';

import type {
  AutoscalerScaleSetStatus,
  AutoscalerStatusResult,
  QueueExecutorStatus,
} from '../lib/autoscaler-status';
import { Eyebrow } from './eyebrow';

const POLL_INTERVAL_MS = 10_000;
const STALENESS_MS = 30_000;

/** Removes a last-known snapshot once its producer's timestamp crosses the
 * same staleness boundary used by the server. This matters when a browser
 * loses auth/network access and polling can no longer obtain the server's
 * own stale-document filtering. */
export function expireAutoscalerStatuses(
  result: AutoscalerStatusResult,
  now = Date.now(),
): AutoscalerStatusResult {
  const statuses = result.statuses.filter((status) => {
    const updatedAt = Date.parse(status.updatedAt);
    return Number.isFinite(updatedAt) && now - updatedAt <= STALENESS_MS;
  });
  const queueExecutor = result.queueExecutor;
  const freshQueueExecutor =
    queueExecutor !== undefined &&
    Number.isFinite(Date.parse(queueExecutor.updatedAt)) &&
    now - Date.parse(queueExecutor.updatedAt) <= STALENESS_MS
      ? queueExecutor
      : undefined;
  if (
    statuses.length === result.statuses.length &&
    freshQueueExecutor === queueExecutor
  ) {
    return result;
  }
  return {
    statuses,
    ...(freshQueueExecutor === undefined
      ? {}
      : { queueExecutor: freshQueueExecutor }),
    warnings: Array.from(
      new Set([...result.warnings, 'Runner autoscaler status is stale.']),
    ),
  };
}

function ScaleSetRow({ status }: { status: AutoscalerScaleSetStatus }) {
  const busy = status.runners.filter((runner) => runner.state === 'busy');
  const idle = status.runners.length - busy.length;
  return (
    <Stack gap={2} data-testid={`autoscaler-scale-set-${status.scaleSet}`}>
      <Group gap="xs" wrap="wrap">
        {status.registrationUrl ? (
          <Anchor
            href={status.registrationUrl}
            target="_blank"
            rel="noreferrer"
            size="sm"
            fw={600}
            data-testid={`autoscaler-registration-${status.scaleSet}`}
          >
            {status.scaleSet}
          </Anchor>
        ) : (
          <Text size="sm" fw={600}>
            {status.scaleSet}
          </Text>
        )}
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
        <Group gap="xs" wrap="wrap">
          {busy.map((runner) => (
            <Badge
              key={runner.name}
              variant="light"
              color="blue"
              size="sm"
              data-testid={`autoscaler-runner-${runner.name}`}
            >
              {runner.name} on {runner.host}
              {runner.jobId ? ` · ${runner.jobId}` : ''}
            </Badge>
          ))}
        </Group>
      )}
    </Stack>
  );
}

function QueueExecutorRow({ status }: { status: QueueExecutorStatus }) {
  return (
    <Stack gap={2} data-testid="queue-executor-status">
      <Group gap="xs" wrap="wrap">
        <Text size="sm" fw={600}>
          Queue executor
        </Text>
        <Badge color={status.ready ? 'green' : 'red'} size="xs">
          {status.ready ? 'ready' : 'not ready'}
        </Badge>
        {status.draining && (
          <Badge color="yellow" size="xs">
            draining
          </Badge>
        )}
        <Text size="xs" c="dimmed">
          {status.activeRuns === undefined
            ? 'active unknown'
            : `${status.activeRuns} active`}{' '}
          · {status.maxConcurrent} max
        </Text>
      </Group>
    </Stack>
  );
}

/** A tiny, isolated polling island: status refreshes every 10 seconds without
 * re-running the dashboard's authoritative queue projections or invalidating
 * their cache. */
export function RunnerAutoscalerStatus({
  initial,
}: {
  initial: AutoscalerStatusResult;
}) {
  const [result, setResult] = useState(initial);

  useEffect(() => {
    let active = true;
    const expire = () => {
      if (active) setResult((previous) => expireAutoscalerStatuses(previous));
    };
    const refresh = async () => {
      try {
        const response = await fetch('/api/runner-status', {
          cache: 'no-store',
        });
        if (!response.ok) return;
        const next = (await response.json()) as AutoscalerStatusResult;
        if (active) setResult(next);
      } catch {
        // The interval still expires an old snapshot locally; polling can
        // recover on its next successful response.
      }
    };
    const timer = window.setInterval(() => {
      expire();
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  if (result.statuses.length === 0 && result.queueExecutor === undefined) {
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
      {result.queueExecutor && (
        <QueueExecutorRow status={result.queueExecutor} />
      )}
    </Stack>
  );
}
