'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

// Same per-browser posture as use-muted-items.ts (#59): which sections a
// maintainer keeps open is their own console's ergonomics, never a signal
// any other viewer or automation should see.
const STORAGE_PREFIX = 'agent-lcars:disclosure:';

/**
 * A `<details>` whose open state survives navigation and reload. Every
 * disclosure on the board previously reset to collapsed on each page
 * render - a maintainer who always works with "Recently finished" open
 * re-opened it on every visit.
 *
 * The server renders `defaultOpen`, then the stored preference applies
 * after hydration (localStorage does not exist during SSR - the same
 * hydrate-then-correct shape as use-muted-items.ts). Passing no
 * `storageKey` renders a plain uncontrolled disclosure pinned to
 * `defaultOpen` - the escape hatch for data-driven force-opens like the
 * task page's anomaly view, where a stored "closed" must not win over a
 * signal that needs eyes.
 */
export function PersistedDetails({
  storageKey,
  defaultOpen = false,
  summary,
  children,
  ...detailsProps
}: {
  storageKey?: string;
  defaultOpen?: boolean;
  summary: ReactNode;
  children: ReactNode;
} & Omit<React.ComponentPropsWithoutRef<'details'>, 'open' | 'onToggle'>) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = window.localStorage.getItem(STORAGE_PREFIX + storageKey);
      if (raw !== null) setOpen(raw === '1');
    } catch {
      // Unavailable storage degrades to the default, never a crash.
    }
  }, [storageKey]);

  return (
    <details
      {...detailsProps}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        if (!storageKey || next === open) return;
        try {
          window.localStorage.setItem(
            STORAGE_PREFIX + storageKey,
            next ? '1' : '0',
          );
        } catch {
          // A failed write just means the preference doesn't stick.
        }
      }}
    >
      <summary style={{ cursor: 'pointer' }}>{summary}</summary>
      {children}
    </details>
  );
}
