'use client';

import {
  EXECUTION_PHASE_LABELS,
  executionPhase,
  type ExecutionRun,
} from '@agent-lcars/dispatch-contracts';
import { Badge, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';

import { RelativeTime } from './relative-time';
import { subscribeToTick } from './shared-tick';

/** Cadence for expiring an execution phase in a long-open tab. */
export const EXECUTION_CLOCK_TICK_MS = 10_000;

/** Shared placement/start presentation for Agents, canonical task and Work.
 * Age expires in an open tab even when the underlying snapshot stops updating. */
export function ExecutionStatus({ run }: { run: ExecutionRun }) {
  const [, refreshClock] = useState(0);
  // The latest source snapshot, read from the shared tick without re-arming a
  // timer per render: this component is mounted once per visible run row.
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);
  useEffect(() => {
    // Rides the page's single shared ticker rather than a timer per row, and
    // only forces a render when the phase actually expires - a run that stays
    // in the same phase costs no render at all.
    let phase = executionPhase(runRef.current);
    return subscribeToTick(EXECUTION_CLOCK_TICK_MS, () => {
      const next = executionPhase(runRef.current);
      if (next === phase) return;
      phase = next;
      refreshClock((tick) => tick + 1);
    });
  }, []);
  const phase = executionPhase(run);
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
          {phase === 'bootstrapping' &&
            placement.reason === 'launch-pending' && (
              <> · Awaiting Job launch</>
            )}
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
