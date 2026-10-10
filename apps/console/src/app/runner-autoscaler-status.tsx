'use client';

import { PIPELINES } from '@agent-lcars/work';
import { Anchor, Badge, Group, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';

import type {
  ArcLaneStatus,
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
/** Backoff for reopening a stream the browser closed after an HTTP error. */
const STREAM_RETRY_MIN_MS = 5_000;
const STREAM_RETRY_MAX_MS = 60_000;

/** Removes a last-known snapshot once its producer's timestamp crosses the
 * same staleness boundary used by the server. A stopped producer writes
 * nothing, so no server event arrives to say so; and a browser that loses
 * auth/network access receives no events at all. Either way the panel must
 * not keep showing a dead snapshot as live. */
export function expireAutoscalerStatuses(
  result: AutoscalerStatusResult,
  now = Date.now(),
): AutoscalerStatusResult {
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
  const admission = result.providerAdmission;
  const freshAdmission =
    admission !== undefined &&
    Number.isFinite(Date.parse(admission.observedAt)) &&
    now - Date.parse(admission.observedAt) <= STALENESS_MS &&
    !admission.providers.some(
      (provider) =>
        provider.cooldown !== undefined &&
        Date.parse(admission.observedAt) <
          Date.parse(provider.cooldown.expiresAt) &&
        now >= Date.parse(provider.cooldown.expiresAt),
    )
      ? admission
      : undefined;
  if (
    lanes?.length === result.lanes?.length &&
    freshQueueExecutor === queueExecutor &&
    freshAdmission === admission
  ) {
    return result;
  }
  return {
    ...result,
    ...(lanes === undefined ? {} : { lanes }),
    ...(result.lanesIncomplete || lanes?.length !== result.lanes?.length
      ? { lanesIncomplete: true }
      : {}),
    queueExecutor: freshQueueExecutor,
    providerAdmission: freshAdmission,
    warnings: Array.from(
      new Set([
        ...result.warnings,
        ...(lanes?.length !== result.lanes?.length ||
        freshQueueExecutor !== queueExecutor
          ? ['Runner capacity status is stale.']
          : []),
        ...(freshAdmission !== admission
          ? [
              'Provider queue and cooldown status is stale or awaiting reset refresh.',
            ]
          : []),
      ]),
    ),
  };
}

function ProviderAdmissionRows({ result }: { result: AutoscalerStatusResult }) {
  const admission = result.providerAdmission;
  const executor = result.queueExecutor;
  return (
    <>
      {PIPELINES.map((pipeline) => {
        const provider = admission?.providers.find(
          (value) => value.pipeline === pipeline,
        );
        const cooldown = provider?.cooldown;
        const cooling =
          cooldown !== undefined && Date.parse(cooldown.expiresAt) > Date.now();
        const window = executor?.claims;
        const executorAccepting =
          executor !== undefined &&
          executor.ready &&
          !executor.draining &&
          executor.activeRuns !== undefined &&
          executor.activeRuns < executor.maxConcurrent;
        const paused =
          executor !== undefined &&
          (!executor.ready ||
            executor.draining ||
            (executor.activeRuns !== undefined &&
              executor.activeRuns >= executor.maxConcurrent));
        const eligible =
          provider === undefined
            ? undefined
            : paused
              ? 0
              : executorAccepting
                ? provider.eligible
                : undefined;
        return (
          <div
            key={pipeline}
            className="console-workspace__section shuttlebay-scale-set"
            data-testid={`provider-admission-${pipeline}`}
          >
            <Stack gap={4}>
              <Group gap="xs" wrap="wrap">
                <Text size="sm" fw={700}>
                  {pipeline}
                </Text>
                {provider === undefined ? (
                  <Badge color="gray" size="xs">
                    admission unavailable
                  </Badge>
                ) : cooling ? (
                  <Badge color="yellow" size="xs">
                    cooling down
                  </Badge>
                ) : (
                  <Badge color="green" size="xs">
                    no active cooldown
                  </Badge>
                )}
                {paused && (
                  <Badge color="yellow" size="xs">
                    {executor.draining
                      ? 'executor draining'
                      : !executor.ready
                        ? 'executor not ready'
                        : 'executor at capacity'}
                  </Badge>
                )}
              </Group>
              <Text size="xs">
                {eligible === undefined
                  ? 'Eligible queue unavailable'
                  : `${eligible} eligible queued`}{' '}
                ·{' '}
                {provider === undefined
                  ? 'queue unavailable'
                  : `${provider.queued} queued · ${provider.deferred} deferred · ${provider.liveClaims} live claims`}
              </Text>
              {cooling && (
                <Text size="xs">
                  Provider limit: cooling down until {cooldown.expiresAt}.
                  Retry/reset deadline from run {cooldown.runId}; reported{' '}
                  {cooldown.observedAt}.
                </Text>
              )}
              {provider !== undefined && (
                <Text size="xs" c="dimmed">
                  Durable provider queue: {provider.eligible} eligible before
                  executor capacity checks. Orchestrator snapshot{' '}
                  {admission?.observedAt}.
                  {provider.maxLiveClaims === undefined
                    ? ''
                    : ` Provider live-claim limit: ${provider.maxLiveClaims}.`}
                </Text>
              )}
              <Text size="xs" c="dimmed">
                {window === undefined
                  ? 'Recent claims unavailable.'
                  : `${window[pipeline]} claims from ${window.windowStart} to ${window.windowEnd}. Executor successful-claim counter; sampled interval, up to 15 minutes.`}
              </Text>
            </Stack>
          </div>
        );
      })}
      <Text size="xs" c="dimmed">
        Eligible work can still wait for host placement, credentials, or
        external checks. Claims precede worker launch.
      </Text>
    </>
  );
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

function QueueExecutorRow({ status }: { status: QueueExecutorStatus }) {
  return (
    <div
      className="console-workspace__section shuttlebay-scale-set"
      data-testid="queue-executor-status"
    >
      <Group gap="xs" wrap="wrap">
        <Text size="sm" fw={700}>
          Direct agent executor
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
  const [storedResult, setResult] = useState(() =>
    expireAutoscalerStatuses(initial),
  );
  // Arrival and render are both clock boundaries. A reset/stale timestamp
  // crossed during RSC transport or a sibling render cannot look healthy.
  const result = expireAutoscalerStatuses(storedResult);

  useEffect(() => {
    // EventSource reconnects by itself after the server ends a stream or the
    // connection drops. It gives up for good on an HTTP error (a 503 during a
    // rollout, a 401 after the session lapses), so reopen it after a backoff
    // in that case. Until a stream delivers, the last snapshot stays and
    // expires locally below.
    let source: EventSource | undefined;
    let reconnect: number | undefined;
    let backoffMs = STREAM_RETRY_MIN_MS;
    const open = () => {
      reconnect = undefined;
      const next = new EventSource(RUNNER_STATUS_STREAM_URL);
      source = next;
      next.addEventListener(RUNNER_STATUS_EVENT, (event) => {
        backoffMs = STREAM_RETRY_MIN_MS;
        try {
          setResult(
            expireAutoscalerStatuses(
              JSON.parse(event.data) as AutoscalerStatusResult,
            ),
          );
        } catch {
          // A malformed frame leaves the previous snapshot to expire locally.
        }
      });
      next.onerror = () => {
        if (next.readyState !== EventSource.CLOSED) return;
        next.close();
        reconnect = window.setTimeout(open, backoffMs);
        backoffMs = Math.min(backoffMs * 2, STREAM_RETRY_MAX_MS);
      };
    };
    open();
    const timer = window.setInterval(() => {
      setResult((previous) => expireAutoscalerStatuses(previous));
    }, EXPIRY_CHECK_INTERVAL_MS);
    return () => {
      source?.close();
      if (reconnect !== undefined) window.clearTimeout(reconnect);
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
        <ProviderAdmissionRows result={result} />
        {(result.lanes?.length ?? 0) === 0 && (
          <Text size="sm" c="dimmed">
            GitHub runner status unavailable.
          </Text>
        )}
        {result.lanes?.map((status) => (
          <ArcLaneRow key={status.lane} status={status} />
        ))}
        {result.queueExecutor && (
          <QueueExecutorRow status={result.queueExecutor} />
        )}
        {!result.queueExecutor && (
          <Text size="sm" c="dimmed">
            Direct executor status unavailable.
          </Text>
        )}
      </div>
    </ShuttlebayWorkspace>
  );
}
