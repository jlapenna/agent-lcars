'use client';

import { Anchor, Badge, Group, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';

import type {
  ArcLaneStatus,
  AutoscalerScaleSetStatus,
  AutoscalerStatusResult,
  QueueExecutorStatus,
} from '../lib/autoscaler-status';
import {
  RUNNER_STATUS_EVENT,
  RUNNER_STATUS_STALENESS_MS,
} from '../lib/runner-status-contract';
import { DataWarnings } from './console-header';
import { ShuttlebayWorkspace } from './shuttlebay/shuttlebay-workspace';

export const RUNNER_STATUS_STREAM_URL = '/api/runner-status/stream';
/** Local clock only: re-checks the last snapshot's age. No network. */
const EXPIRY_CHECK_INTERVAL_MS = 10_000;
const STALENESS_MS = RUNNER_STATUS_STALENESS_MS;

/** Removes a last-known snapshot once its producer's timestamp crosses the
 * same staleness boundary used by the server. A stopped producer writes
 * nothing, so no server event arrives to say so; and a browser that loses
 * auth/network access receives no events at all. Either way the panel must
 * not keep showing a dead snapshot as live. */
export function expireAutoscalerStatuses(
  result: AutoscalerStatusResult,
  now = Date.now(),
): AutoscalerStatusResult {
  const statuses = result.statuses.filter((status) => {
    const updatedAt = Date.parse(status.updatedAt);
    return Number.isFinite(updatedAt) && now - updatedAt <= STALENESS_MS;
  });
  const queueExecutor = result.queueExecutor;
  const lanes = result.lanes?.filter((status) => {
    const updatedAt = Date.parse(status.updatedAt);
    return Number.isFinite(updatedAt) && now - updatedAt <= STALENESS_MS;
  });
  const freshQueueExecutor =
    queueExecutor !== undefined &&
    Number.isFinite(Date.parse(queueExecutor.updatedAt)) &&
    now - Date.parse(queueExecutor.updatedAt) <= STALENESS_MS
      ? queueExecutor
      : undefined;
  if (
    statuses.length === result.statuses.length &&
    lanes?.length === result.lanes?.length &&
    freshQueueExecutor === queueExecutor
  ) {
    return result;
  }
  return {
    statuses,
    ...(lanes === undefined ? {} : { lanes }),
    ...(freshQueueExecutor === undefined
      ? {}
      : { queueExecutor: freshQueueExecutor }),
    warnings: Array.from(
      new Set([...result.warnings, 'Runner capacity status is stale.']),
    ),
  };
}

function ArcLaneRow({ status }: { status: ArcLaneStatus }) {
  return (
    <div
      className="console-workspace__section shuttlebay-scale-set"
      data-testid={`arc-lane-${status.lane}`}
    >
      <Group gap="xs" wrap="wrap">
        <Anchor
          href={status.registrationUrl}
          target="_blank"
          rel="noreferrer"
          size="sm"
          fw={700}
        >
          {status.lane}
        </Anchor>
        {status.pendingJobs > 0 && (
          <Badge color="yellow" size="xs">
            {status.pendingJobs} pending
          </Badge>
        )}
        <Text size="xs" c="dimmed">
          {status.runningJobs} running · {status.idleRunners} idle ·{' '}
          {status.registeredRunners} registered · {status.desiredRunners}{' '}
          desired · {status.maxRunners} max
        </Text>
      </Group>
    </div>
  );
}

/** Each autoscaler (scale set) is its own bordered section so a fleet with
 * several queues reads as distinct panels rather than one run-on list -
 * every runner is shown here, not just the busy ones, so the panel doubles
 * as "what task is this queue's capacity spending right now?". */
function ScaleSetRow({ status }: { status: AutoscalerScaleSetStatus }) {
  const busy = status.runners.filter((runner) => runner.state === 'busy');
  const idle = status.runners.length - busy.length;
  return (
    <div
      className="console-workspace__section shuttlebay-scale-set"
      data-testid={`autoscaler-scale-set-${status.scaleSet}`}
    >
      <Stack gap={4}>
        <Group gap="xs" wrap="wrap">
          {status.registrationUrl ? (
            <Anchor
              href={status.registrationUrl}
              target="_blank"
              rel="noreferrer"
              size="sm"
              fw={700}
              data-testid={`autoscaler-registration-${status.scaleSet}`}
            >
              {status.scaleSet}
            </Anchor>
          ) : (
            <Text size="sm" fw={700}>
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
        {status.runners.length > 0 && (
          <Group gap="xs" wrap="wrap">
            {status.runners.map((runner) => (
              <Badge
                key={runner.name}
                variant={runner.state === 'busy' ? 'light' : 'outline'}
                color={runner.state === 'busy' ? 'blue' : 'gray'}
                size="sm"
                data-testid={`autoscaler-runner-${runner.name}`}
              >
                {runner.name} on {runner.host}
                {runner.jobId
                  ? ` · ${runner.jobId}`
                  : runner.state === 'idle'
                    ? ' · idle'
                    : ''}
              </Badge>
            ))}
          </Group>
        )}
      </Stack>
    </div>
  );
}

function QueueExecutorRow({ status }: { status: QueueExecutorStatus }) {
  return (
    <div
      className="console-workspace__section shuttlebay-scale-set"
      data-testid="queue-executor-status"
    >
      <Group gap="xs" wrap="wrap">
        <Text size="sm" fw={700}>
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
    </div>
  );
}

/** A tiny, isolated live island: the server pushes a fresh projection
 * whenever the autoscaler writes a status change (or its heartbeat), without
 * re-running the dashboard's authoritative queue projections or invalidating
 * their cache. */
export function RunnerAutoscalerStatus({
  initial,
}: {
  initial: AutoscalerStatusResult;
}) {
  const [result, setResult] = useState(initial);

  useEffect(() => {
    // EventSource reconnects by itself whenever the server ends a stream or
    // the connection drops; until then the last snapshot stays and expires
    // locally below.
    const source = new EventSource(RUNNER_STATUS_STREAM_URL);
    source.addEventListener(RUNNER_STATUS_EVENT, (event) => {
      try {
        setResult(JSON.parse(event.data) as AutoscalerStatusResult);
      } catch {
        // A malformed frame leaves the previous snapshot to expire locally.
      }
    });
    const timer = window.setInterval(() => {
      setResult((previous) => expireAutoscalerStatuses(previous));
    }, EXPIRY_CHECK_INTERVAL_MS);
    return () => {
      source.close();
      window.clearInterval(timer);
    };
  }, []);

  return (
    <ShuttlebayWorkspace
      warnings={
        result.warnings.length > 0 ? (
          <DataWarnings warnings={result.warnings} />
        ) : undefined
      }
      toolbar={
        <Text c="dimmed" size="sm">
          Updates live as runner capacity changes.
        </Text>
      }
    >
      <div data-testid="runner-autoscaler-status">
        {result.statuses.map((status) => (
          <ScaleSetRow key={status.scaleSet} status={status} />
        ))}
        {result.lanes?.map((status) => (
          <ArcLaneRow key={status.lane} status={status} />
        ))}
        {result.queueExecutor && (
          <QueueExecutorRow status={result.queueExecutor} />
        )}
      </div>
    </ShuttlebayWorkspace>
  );
}
