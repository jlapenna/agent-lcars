'use client';

import { useEffect, useState } from 'react';

import {
  formatAbsoluteLocal,
  formatCompactRelativeTime,
  formatRelativeTime,
} from './format';
import { subscribeToTick } from './shared-tick';

// Matches refresh-button.tsx's cadence for its "Updated Xm ago" label - one
// shared rhythm keeps every visible age on the page moving together.
export const TICK_MS = 30_000;

function formatFor(variant: 'compact' | 'full', iso: string): string {
  return variant === 'compact'
    ? formatCompactRelativeTime(iso)
    : formatRelativeTime(iso);
}

/**
 * A relative timestamp that stays truthful in a long-open tab: the server
 * renders the label once, then the client re-derives it every 30s. The
 * initial client render recomputes from the same `iso`, so it can only
 * differ from the server string when hydration crosses a minute boundary -
 * `suppressHydrationWarning` covers that sliver, and the first tick heals
 * it (the SSR-mismatch trap format.ts's doc comment warns about).
 *
 * Renders a real `<time dateTime>` and, once mounted, a `title` with the
 * viewer-local absolute time - set post-mount because the server's
 * timezone would disagree with the browser's.
 */
export function RelativeTime({
  iso,
  variant = 'full',
}: {
  iso: string;
  /** 'compact' -> "2h ago" (dense rows); 'full' -> "2 hours ago". */
  variant?: 'compact' | 'full';
}) {
  const [label, setLabel] = useState(() => formatFor(variant, iso));
  const [title, setTitle] = useState<string | undefined>(undefined);

  useEffect(() => {
    // `setLabel` with an unchanged string is a no-op for React, so a tick only
    // costs a render when the label actually aged across a unit boundary.
    const update = () =>
      setLabel((previous) => {
        const next = formatFor(variant, iso);
        return next === previous ? previous : next;
      });
    update();
    setTitle(formatAbsoluteLocal(iso));
    return subscribeToTick(TICK_MS, update);
  }, [iso, variant]);

  return (
    <time dateTime={iso} title={title} suppressHydrationWarning>
      {label}
    </time>
  );
}
