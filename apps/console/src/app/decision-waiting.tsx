'use client';

import { useEffect, useState } from 'react';

import { decisionSlaSummary, isOverDecisionSla } from './decision-sla';
import { RelativeTime, TICK_MS } from './relative-time';
import { subscribeToTick } from './shared-tick';

/**
 * The current time, re-read on RelativeTime's cadence so an SLA flag turns
 * on in a long-open tab at the same moment the ages beside it move. Null
 * until mount: a flag is an extra text node, so a decision crossing the line
 * between server render and hydration would be a structural mismatch that
 * suppressHydrationWarning cannot cover. The first client render matches the
 * server's unflagged markup, and the flag arrives as an ordinary update.
 */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    // The shared ticker, not a per-row interval: `DecisionWaiting` renders one
    // per decision row, and `RelativeTime` in the same row already subscribes
    // to this cadence. A private timer per row meant one React state update
    // per row per 30s instead of the single coalesced batch shared-tick.ts
    // exists to provide.
    return subscribeToTick(TICK_MS, () => setNow(Date.now()));
  }, []);
  return now;
}

/** A decision row's `waiting 3h ago · over SLA` (design/fleet-console.html). */
export function DecisionWaiting({ since }: { since: string }) {
  const now = useNow();
  const late = now !== null && isOverDecisionSla(since, now);
  return (
    <span
      className={late ? 'ops-inbox__late' : undefined}
      data-over-sla={late ? '' : undefined}
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
  // Before mount nothing counts as late; the oldest age still renders.
  const { overSla, oldest } = decisionSlaSummary(
    waitingSince,
    useNow() ?? Number.NEGATIVE_INFINITY,
  );
  if (!oldest) return null;
  return (
    <span data-testid="decision-sla-meta">
      {overSla > 0 && `${overSla} over SLA · `}
      oldest <RelativeTime iso={oldest} variant="compact" />
    </span>
  );
}
