'use client';

import { Loader } from '@mantine/core';
import Link from 'next/link';
import type { MouseEvent } from 'react';

import { repoDisplayName } from '../lib/watched-repo';
import type { BoardCard } from './board-card';
import { DecisionWaiting } from './decision-waiting';
import { inboxCardAgent } from './inbox-card';
import { ItemOverflowMenu } from './item-overflow-menu';
import { queueDisclosureLabels, queueReasonFor } from './queue-reason';

export function QueueItemRow({
  card,
  href,
  selected,
  loading,
  muted,
  onNavigate,
  onToggleMute,
}: {
  card: BoardCard;
  href: string;
  selected: boolean;
  loading?: boolean;
  muted?: boolean;
  onNavigate?: () => void;
  onToggleMute?: () => void;
}) {
  const { item } = card;
  const reason = queueReasonFor(item);
  const agent = inboxCardAgent(card);
  const hiddenLabels = queueDisclosureLabels(item);
  const handleNavigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    onNavigate?.();
  };

  return (
    <div
      className="queue-item-row"
      data-selected={selected ? '' : undefined}
      data-loading={loading ? '' : undefined}
      data-reason={reason?.type}
      data-testid={`queue-row-${item.number}`}
    >
      <Link
        href={href}
        scroll={false}
        className="queue-item-row__link"
        aria-current={selected ? 'true' : undefined}
        aria-busy={loading || undefined}
        onClick={handleNavigate}
      >
        <div className="queue-item-row__text">
          <div className="ops-inbox__kind">{reason?.label ?? 'Decision'}</div>
          <span
            className="ops-inbox__title queue-item-row__title"
            title={item.title}
          >
            {item.title}
          </span>
          <div className="ops-inbox__meta">
            <span className="ops-ref">
              {repoDisplayName(item.repo)} {item.kind === 'pr' ? 'PR ' : ''}#
              {item.number}
            </span>
            {agent && <span>{agent}</span>}
            <DecisionWaiting since={item.decisionSince ?? item.updatedAt} />
            {item.author && <span>by {item.author}</span>}
            {item.ciRunning && (
              <span
                className="queue-row-signal"
                role="status"
                aria-label="CI running"
                title="CI running"
              >
                <span aria-hidden="true" />
              </span>
            )}
            {hiddenLabels.length > 0 && (
              <span
                className="queue-label-count"
                aria-label={`${hiddenLabels.length} labels shown in detail`}
              >
                +{hiddenLabels.length}
              </span>
            )}
          </div>
        </div>
        {loading ? (
          <Loader
            size={16}
            className="queue-item-row__loader"
            aria-label="Loading item details"
          />
        ) : (
          <span
            className="ops-row-action queue-item-row__respond"
            aria-hidden="true"
          >
            Respond
          </span>
        )}
      </Link>

      <div className="queue-item-row__overflow">
        <ItemOverflowMenu
          item={item}
          muted={muted}
          onToggleMute={onToggleMute}
        />
      </div>
    </div>
  );
}
