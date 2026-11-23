'use client';

import {
  type ReactNode,
  Suspense,
  useState,
  useSyncExternalStore,
} from 'react';

// Nothing ever changes: the snapshot pair only distinguishes hydration.
const unsubscribe = () => undefined;
const subscribeNever = () => unsubscribe;

/**
 * A Suspense boundary for the document's first, streamed render only.
 *
 * On a hard load the server streams each page's fallback and then its data,
 * which is what these boundaries exist for. On a client navigation, though,
 * a newly mounted boundary commits its fallback first, and React then holds
 * the resolved content behind its 300 ms fallback-reveal throttle even when
 * the RSC payload finished in a fraction of that. Mounting without the
 * boundary instead lets the router's transition keep the current page on
 * screen until the next one is ready, so navigation swaps once, without a
 * skeleton and without the throttle.
 *
 * The choice is fixed per instance at mount: it renders the boundary while
 * hydrating (matching the server markup) and never switches afterwards, so a
 * later re-render cannot remount its children.
 */
export function NavSuspense({
  fallback,
  children,
}: {
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const hydrating = useSyncExternalStore(
    subscribeNever,
    () => false,
    () => true,
  );
  const [streamed] = useState(hydrating);
  return streamed ? (
    <Suspense fallback={fallback}>{children}</Suspense>
  ) : (
    children
  );
}
