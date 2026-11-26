'use client';

import { useLinkStatus } from 'next/link';

/**
 * Client navigations keep the current page on screen until the next one is
 * ready (see NavSuspense), so the clicked link signals the wait instead. The
 * CSS delays the signal so a fast navigation shows nothing.
 */
export function LinkPendingSignal() {
  const { pending } = useLinkStatus();
  return pending ? (
    <span className="lcars-nav-pending" aria-hidden="true" />
  ) : null;
}
