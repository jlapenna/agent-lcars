'use client';

import { useEffect, useState } from 'react';

import {
  formatAbsoluteLocal,
  formatCompactRelativeTime,
  formatRelativeTime,
} from './format';

// Matches refresh-button.tsx's cadence for its "Updated Xm ago" label - one
// shared rhythm keeps every visible age on the page moving together.
const TICK_MS = 30_000;

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
    const update = () => setLabel(formatFor(variant, iso));
    update();
    setTitle(formatAbsoluteLocal(iso));
    const id = setInterval(update, TICK_MS);
    return () => clearInterval(id);
  }, [iso, variant]);

  return (
    <time dateTime={iso} title={title} suppressHydrationWarning>
      {label}
    </time>
  );
}
