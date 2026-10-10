'use client';

import { Button } from '@mantine/core';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

import type { QuickTaskSourceIdentity } from '../lib/quick-task-evidence';
import type { WatchedRepo } from '../lib/watched-repo';

const QuickTaskDialog = dynamic(
  // eslint-disable-next-line no-restricted-syntax -- #2201 intentional browser-only on-demand chunk; a static import downloads creation/evidence code before any decision can be used.
  () => import('./quick-task-dialog').then((module) => module.QuickTaskDialog),
  {
    ssr: false,
    loading: () => (
      <Button
        className="lcars-action-button"
        data-accent="amber"
        size="compact-xs"
        disabled
        aria-busy="true"
      >
        Opening New work…
      </Button>
    ),
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
  const [activated, setActivated] = useState(false);
  useEffect(() => setHydrated(true), []);
  if (activated) {
    return (
      <QuickTaskDialog
        watchedRepos={watchedRepos}
        initialRepoKey={initialRepoKey}
        sourceIdentities={sourceIdentities}
        size={size}
        initiallyOpen
      />
    );
  }
  return (
    <Button
      className="lcars-action-button"
      data-accent="amber"
      size={size}
      disabled={!hydrated}
      onClick={() => setActivated(true)}
    >
      New work
    </Button>
  );
}
