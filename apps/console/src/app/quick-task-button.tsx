'use client';

import { Button } from '@mantine/core';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

import type { QuickTaskSourceIdentity } from '../lib/quick-task-evidence';
import type { WatchedRepo } from '../lib/watched-repo';
import type { QuickTaskActivation } from './quick-task-dialog';

const QuickTaskDialog = dynamic(
  // eslint-disable-next-line no-restricted-syntax -- #2201 intentional browser-only on-demand chunk; a static import downloads creation/evidence code before any decision can be used.
  () => import('./quick-task-dialog').then((module) => module.QuickTaskDialog),
  {
    ssr: false,
    loading: () => null,
  },
);

/** Keep secondary creation/evidence dependencies off the Inbox decision's
 * initial download path. Once opened, retain the dialog and its draft. */
export function QuickTaskButton({
  watchedRepos,
  initialRepoKey,
  sourceIdentities,
  size = 'compact-sm',
}: {
  watchedRepos: WatchedRepo[];
  initialRepoKey?: string;
  sourceIdentities?: QuickTaskSourceIdentity[];
  size?: string;
}) {
  const [hydrated, setHydrated] = useState(false);
  const [activation, setActivation] = useState<QuickTaskActivation | null>(
    null,
  );
  const [ready, setReady] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <>
      <Button
        className="lcars-action-button"
        data-accent="amber"
        size={size}
        disabled={!hydrated}
        aria-busy={!!activation && !ready}
        onClick={() => {
          if (activation && !ready) return;
          // Snapshot at the click, not after the lazy chunk arrives: a route
          // change during loading must not reattribute the originating work.
          setActivation({
            pathname: window.location.pathname,
            search: window.location.search,
            identities: sourceIdentities ?? [],
            capturedAt: new Date().toISOString(),
          });
        }}
      >
        New work
      </Button>
      {activation && (
        <QuickTaskDialog
          watchedRepos={watchedRepos}
          initialRepoKey={initialRepoKey}
          activation={activation}
          onReady={() => setReady(true)}
        />
      )}
    </>
  );
}
