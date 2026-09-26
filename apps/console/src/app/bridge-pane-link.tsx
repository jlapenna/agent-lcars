'use client';

import { Anchor, type AnchorProps } from '@mantine/core';
import { type ReactNode, useSyncExternalStore } from 'react';

const DESKTOP_PANE_QUERY = '(min-width: 64em)';
const viewportSubscribers = new Set<() => void>();
let desktopPaneMedia: MediaQueryList | undefined;

function getDesktopPaneMedia(): MediaQueryList | undefined {
  if (typeof window === 'undefined' || !('matchMedia' in window)) {
    return undefined;
  }
  desktopPaneMedia ??= window.matchMedia(DESKTOP_PANE_QUERY);
  return desktopPaneMedia;
}

function emitViewportChange() {
  for (const subscriber of viewportSubscribers) subscriber();
}

function subscribeToViewport(subscriber: () => void): () => void {
  const media = getDesktopPaneMedia();
  if (!media) return () => undefined;

  if (viewportSubscribers.size === 0) {
    media.addEventListener('change', emitViewportChange);
  }
  viewportSubscribers.add(subscriber);

  return () => {
    viewportSubscribers.delete(subscriber);
    if (viewportSubscribers.size === 0) {
      media.removeEventListener('change', emitViewportChange);
      desktopPaneMedia = undefined;
    }
  };
}

function desktopPaneSnapshot(): boolean {
  return getDesktopPaneMedia()?.matches ?? false;
}

function mobilePaneSnapshot(): boolean {
  return false;
}

/**
 * A Bridge row link has two destinations for the same intent: the canonical
 * full-page view on a phone, and the row selection in the desktop detail pane.
 * Keep the canonical view in `href` so the link still works before hydration
 * and while the mobile layout is active. After hydration the same breakpoint
 * as the two-pane CSS swaps desktop links to the server-rendered `?sel=` URL.
 * The initial client render also uses the mobile target, avoiding a hydration
 * mismatch while preserving a useful no-JavaScript fallback.
 */
export function BridgePaneLink({
  mobileHref,
  paneHref,
  children,
  target,
  rel,
  ...props
}: AnchorProps & {
  mobileHref: string;
  paneHref: string;
  children: ReactNode;
  target?: '_blank' | '_self' | '_parent' | '_top';
  rel?: string;
  'data-testid'?: string;
}) {
  const desktopPane = useSyncExternalStore(
    subscribeToViewport,
    desktopPaneSnapshot,
    mobilePaneSnapshot,
  );

  return (
    <Anchor
      href={desktopPane ? paneHref : mobileHref}
      target={desktopPane ? undefined : target}
      rel={desktopPane ? undefined : rel}
      {...props}
    >
      {children}
    </Anchor>
  );
}
