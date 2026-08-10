'use client';

import { Button, Group, Text } from '@mantine/core';
import { IconChevronLeft } from '@tabler/icons-react';
import type { ReactNode } from 'react';

import type { ActionItem } from '../lib/action-items';
import type { WatchedRepo } from '../lib/watched-repo';
import { QuickTaskButton } from './quick-task-button';
import { RefreshButton } from './refresh-button';

/**
 * The complete phone-only control surface for the Inbox.
 *
 * The desktop workspace is deliberately a two-pane instrument; on a phone
 * the same job becomes a single, contextual flow. Keeping its command deck
 * together prevents route chrome, selection context, and freshness state
 * from drifting into separate competing headers again.
 */
export function InboxMobileCommandDeck({
  view,
  openItemCount,
  selectedItem,
  backHref,
  watchedRepos,
  initialRepoKey,
  utilityMenu,
  scopeLabel,
  dataFreshness,
}: {
  view: 'list' | 'detail';
  openItemCount: number;
  selectedItem?: Pick<ActionItem, 'repo' | 'number'>;
  backHref: string;
  watchedRepos: WatchedRepo[];
  initialRepoKey?: string;
  utilityMenu: ReactNode;
  scopeLabel?: string;
  dataFreshness?: ReactNode;
}) {
  return (
    <>
      <div className="queue-mobile-bar" data-testid="inbox-mobile-command-deck">
        {view === 'detail' ? (
          <>
            <Button
              component="a"
              href={backHref}
              variant="filled"
              color="blue"
              leftSection={<IconChevronLeft aria-hidden="true" size={18} />}
              className="queue-mobile-back"
              aria-label="Back to Inbox list"
            >
              Back
            </Button>
            <Text
              component="span"
              ff="monospace"
              size="xs"
              c="dimmed"
              truncate
              className="queue-mobile-detail-identity"
            >
              {selectedItem
                ? `${selectedItem.repo.name} / #${selectedItem.number}`
                : 'Item unavailable'}
            </Text>
          </>
        ) : (
          <>
            <div
              className="queue-mobile-identity"
              aria-label={`${openItemCount} open queue items`}
            >
              <Text component="span" className="queue-mobile-title">
                Inbox
              </Text>
              <Text component="span" ff="monospace" size="xs">
                {openItemCount.toString().padStart(2, '0')} open
              </Text>
            </div>
            <Group gap={4} wrap="nowrap" className="queue-mobile-utilities">
              <QuickTaskButton
                watchedRepos={watchedRepos}
                initialRepoKey={initialRepoKey}
                size="compact-xs"
              />
              <RefreshButton compact bustsGithubCache />
              {utilityMenu}
            </Group>
          </>
        )}
      </div>

      {dataFreshness && (
        <div className="queue-mobile-meta">
          {scopeLabel && (
            <Text component="span" className="queue-mobile-scope">
              {scopeLabel}
            </Text>
          )}
          <div className="queue-mobile-freshness">{dataFreshness}</div>
        </div>
      )}
    </>
  );
}
