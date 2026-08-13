'use client';

import { Button, Text } from '@mantine/core';
import { IconChevronLeft } from '@tabler/icons-react';
import type { ReactNode } from 'react';

import type { ActionItem } from '../lib/action-items';

/**
 * The contextual phone-only control surface for Inbox detail.
 *
 * The desktop workspace is deliberately a two-pane instrument; on a phone
 * the same job becomes a single, contextual flow. The shared ConsoleHeader
 * owns list identity and global utilities at every viewport; this component
 * adds only the selected-item Back affordance and compact data metadata.
 */
export function InboxMobileCommandDeck({
  view,
  selectedItem,
  backHref,
  scopeLabel,
  dataFreshness,
}: {
  view: 'list' | 'detail';
  selectedItem?: Pick<ActionItem, 'repo' | 'number'>;
  backHref: string;
  scopeLabel?: string;
  dataFreshness?: ReactNode;
}) {
  return (
    <>
      {view === 'detail' && (
        <div
          className="queue-mobile-bar"
          data-testid="inbox-mobile-command-deck"
        >
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
        </div>
      )}

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
