'use client';

import { useEffect, useState } from 'react';

import { decisionSlaSummary, isOverDecisionSla } from './decision-sla';
import { RelativeTime, TICK_MS } from './relative-time';

/**
 * The current time, re-read on RelativeTime's cadence so an SLA flag turns
 * on in a long-open tab at the same moment the ages beside it move.
 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** A decision row's `waiting 3h ago · over SLA` (design/fleet-console.html). */
export function DecisionWaiting({ since }: { since: string }) {
  const late = isOverDecisionSla(since, useNow());
  return (
    <span
      className={late ? 'ops-inbox__late' : undefined}
      data-over-sla={late ? '' : undefined}
      suppressHydrationWarning
    >
      waiting <RelativeTime iso={since} variant="compact" />
      {late && ' · over SLA'}
    </span>
  );
}

/** A decision panel header's `2 over SLA · oldest 3h ago`. */
export function DecisionSlaMeta({
  waitingSince,
}: {
  waitingSince: readonly string[];
}) {
  const { overSla, oldest } = decisionSlaSummary(waitingSince, useNow());
  if (!oldest) return null;
  return (
    <span data-testid="decision-sla-meta" suppressHydrationWarning>
      {overSla > 0 && `${overSla} over SLA · `}
      oldest <RelativeTime iso={oldest} variant="compact" />
    </span>
  );
}
