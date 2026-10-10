'use client';

import { Text } from '@mantine/core';
import { useEffect, useState } from 'react';

import type { FleetSummary } from '../lib/agent-activity';

/** Only a producer's original deadline authorizes a capacity claim. Missing
 * evidence fails closed; an SSE heartbeat or RSC fetch cannot renew it. */
function useFreshFleet(fleet: FleetSummary | undefined) {
  // The server has already checked freshness. Zero gives a deterministic
  // hydration snapshot; the mounted clock immediately checks original dates.
  const [now, setNow] = useState(0);
  const githubDeadline = Date.parse(fleet?.githubExpiresAt ?? '');
  const executorDeadline = Date.parse(fleet?.directExecutor?.expiresAt ?? '');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      const next = Math.min(
        ...[githubDeadline, executorDeadline].filter(
          (value) => value >= current,
        ),
      );
      if (Number.isFinite(next)) {
        timer = setTimeout(update, Math.min(next - current + 1, 2_147_483_647));
      }
    };
    update();
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [githubDeadline, executorDeadline]);
  return {
    online:
      Number.isFinite(githubDeadline) && now <= githubDeadline
        ? fleet?.online
        : undefined,
    busy:
      Number.isFinite(githubDeadline) && now <= githubDeadline
        ? fleet?.busy
        : undefined,
    directExecutor:
      Number.isFinite(executorDeadline) && now <= executorDeadline
        ? fleet?.directExecutor
        : undefined,
  };
}

/** Small live islands keep the server-owned activity tree out of the client
 * bundle while expiring capacity even when streams stall or never change. */
export function FleetChip({ fleet }: { fleet?: FleetSummary }) {
  const fresh = useFreshFleet(fleet);
  if (fleet === undefined) {
    return (
      <Text size="xs" c="dimmed" data-testid="fleet-chip">
        Runner status unavailable
      </Text>
    );
  }
  return (
    <Text size="xs" c="dimmed" data-testid="fleet-chip">
      {fresh.online === undefined
        ? 'GitHub runner status unavailable'
        : `${fresh.online} GitHub runner${fresh.online === 1 ? '' : 's'} registered (${fresh.busy ?? 0} running)`}
      {' · '}
      {fresh.directExecutor === undefined
        ? 'Direct executor status unavailable'
        : `Direct executor ${fresh.directExecutor.ready ? 'ready' : 'not ready'}${fresh.directExecutor.draining ? ', draining' : ''} (limit ${fresh.directExecutor.maxConcurrent})`}
    </Text>
  );
}

export function FleetRunnerOccupancy({ fleet }: { fleet?: FleetSummary }) {
  const fresh = useFreshFleet(fleet);
  if (fresh.online === undefined) return null;
  return (
    <Text size="xs" c="dimmed" data-testid="metric-runner-occupancy">
      {fresh.busy ?? 0}/{fresh.online} GitHub runners running
    </Text>
  );
}
