'use client';

import {
  EXECUTION_PHASE_LABELS,
  executionPhase,
  type ExecutionRun,
} from '@agent-lcars/dispatch-contracts';
import { Badge, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';

import { RelativeTime } from './relative-time';

/** Shared placement/start presentation for Agents, canonical task and Work.
 * Age expires in an open tab even when the underlying snapshot stops updating. */
export function ExecutionStatus({ run }: { run: ExecutionRun }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  const phase = executionPhase(run, now);
  if (phase === undefined) return null;
  const placement = run.queue?.placement;
  return (
    <Stack gap={2} data-testid="execution-status">
      <Badge
        variant="outline"
        color={phase === 'provider-execution' ? 'blue' : 'gray'}
        size="xs"
        suppressHydrationWarning
      >
        {EXECUTION_PHASE_LABELS[phase]}
      </Badge>
      {placement && (
        <Text size="xs" c="dimmed">
          Placement observed <RelativeTime iso={placement.observedAt} />
          {phase === 'waiting-for-placement' && (
            <>
              {' '}
              ·{' '}
              {placement.reason === 'unschedulable'
                ? 'Scheduler cannot place this Pod'
                : 'Awaiting scheduler placement'}
              {placement.jobCreatedAt && (
                <>
                  {' '}
                  · Job created <RelativeTime iso={placement.jobCreatedAt} />
                </>
              )}
            </>
          )}
        </Text>
      )}
      {run.queue?.startDeadlineAt && !run.queue.firstHeartbeatAt && (
        <Text size="xs" c="dimmed">
          Startup deadline <RelativeTime iso={run.queue.startDeadlineAt} />
        </Text>
      )}
    </Stack>
  );
}
