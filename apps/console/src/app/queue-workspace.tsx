'use client';

import { Button, Group, Menu, Stack, Text, Title } from '@mantine/core';
import {
  IconArrowsSort,
  IconChevronLeft,
  IconFilter,
} from '@tabler/icons-react';
import { useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import type { ActionType } from '../lib/action-items';
import type { WatchedRepo } from '../lib/watched-repo';
import { repoItemKey } from '../lib/watched-repo';
import { ActionItemCard } from './action-item-card';
import type { BoardCard } from './board-card';
import { QueueItemRow } from './queue-item-row';
import { queueReasonFor } from './queue-reason';
import { QuickTaskButton } from './quick-task-button';
import { RefreshButton } from './refresh-button';
import { useMutedItems } from './use-muted-items';

type QueueFilter = 'all' | ActionType;
type QueueSort = 'priority' | 'newest' | 'oldest';

const FILTER_OPTIONS: Array<{ value: QueueFilter; label: string }> = [
  { value: 'all', label: 'All reasons' },
  { value: 'human-needed', label: 'Human needed' },
  { value: 'review-requested', label: 'Review requested' },
  { value: 'run-failed', label: 'Run failed' },
  { value: 'merge-blocked', label: 'Merge blocked' },
  { value: 'silent-error', label: 'Silent error' },
];

const SORT_OPTIONS: Array<{ value: QueueSort; label: string }> = [
  { value: 'priority', label: 'Priority' },
  { value: 'newest', label: 'Newest update' },
  { value: 'oldest', label: 'Oldest update' },
];

export function queueSelectionHref(
  currentSearch: string,
  itemKey?: string,
): string {
  const params = new URLSearchParams(currentSearch);
  if (itemKey) params.set('item', itemKey);
  else params.delete('item');
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

export function QueueWorkspace({
  cards,
  selectedItemKey,
  watchedRepos,
  mobileUtilityMenu,
}: {
  cards: BoardCard[];
  selectedItemKey?: string;
  watchedRepos: WatchedRepo[];
  mobileUtilityMenu: ReactNode;
}) {
  const searchParams = useSearchParams();
  const currentSearch = searchParams.toString();
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [sort, setSort] = useState<QueueSort>('priority');
  const { muted, mute, unmute } = useMutedItems();

  const visibleCards = useMemo(() => {
    const filtered = cards.filter(({ item }) => {
      if (muted.has(repoItemKey(item.repo, item.number))) return false;
      return filter === 'all' || item.actionTypes.includes(filter);
    });

    return [...filtered].sort((a, b) => {
      if (sort === 'newest' || sort === 'oldest') {
        const delta =
          new Date(b.item.updatedAt).getTime() -
          new Date(a.item.updatedAt).getTime();
        return sort === 'newest' ? delta : -delta;
      }
      return (
        (queueReasonFor(a.item)?.rank ?? Number.MAX_SAFE_INTEGER) -
        (queueReasonFor(b.item)?.rank ?? Number.MAX_SAFE_INTEGER)
      );
    });
  }, [cards, filter, muted, sort]);

  const mutedCards = cards.filter(({ item }) =>
    muted.has(repoItemKey(item.repo, item.number)),
  );
  const selectedCard = selectedItemKey
    ? visibleCards.find(
        ({ item }) => repoItemKey(item.repo, item.number) === selectedItemKey,
      )
    : visibleCards[0];
  const explicitDetail = selectedItemKey !== undefined;
  const backHref = queueSelectionHref(currentSearch);

  return (
    <section
      className="queue-workspace"
      data-mobile-view={explicitDetail ? 'detail' : 'list'}
      aria-label="Decision Inbox"
    >
      <div className="queue-mobile-bar">
        {explicitDetail ? (
          <>
            <Button
              component="a"
              href={backHref}
              variant="filled"
              color="orange"
              leftSection={<IconChevronLeft aria-hidden="true" size={18} />}
              className="queue-mobile-back"
            >
              Queue
            </Button>
            <Text component="span" ff="monospace" size="xs" c="dimmed" truncate>
              {selectedCard
                ? `${selectedCard.item.repo.name} / #${selectedCard.item.number}`
                : 'Item unavailable'}
            </Text>
          </>
        ) : (
          <>
            <div className="queue-mobile-identity">
              <Text component="span" fw={700} tt="uppercase">
                Queue
              </Text>
              <Text component="span" ff="monospace" size="xs">
                {visibleCards.length.toString().padStart(2, '0')}
              </Text>
            </div>
            <Group gap={4} wrap="nowrap" className="queue-mobile-utilities">
              <QuickTaskButton watchedRepos={watchedRepos} size="compact-xs" />
              <RefreshButton compact bustsGithubCache />
              {mobileUtilityMenu}
            </Group>
          </>
        )}
      </div>

      <div className="queue-workspace__list">
        <div className="queue-workspace__list-header">
          <div>
            <Title order={2} size="h3">
              Decision Inbox
            </Title>
            <Text size="xs" c="dimmed">
              {visibleCards.length}{' '}
              {visibleCards.length === 1 ? 'item' : 'items'} · needs your
              decision or response
            </Text>
          </div>
          <Group gap={6} wrap="nowrap" className="queue-list-controls">
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <Button
                  variant="subtle"
                  color="gray"
                  size="compact-sm"
                  leftSection={<IconFilter aria-hidden="true" size={14} />}
                >
                  Filter
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {FILTER_OPTIONS.map((option) => (
                  <Menu.Item
                    key={option.value}
                    onClick={() => setFilter(option.value)}
                    data-active={filter === option.value ? '' : undefined}
                  >
                    {option.label}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <Button
                  variant="subtle"
                  color="gray"
                  size="compact-sm"
                  leftSection={<IconArrowsSort aria-hidden="true" size={14} />}
                >
                  Sort
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {SORT_OPTIONS.map((option) => (
                  <Menu.Item
                    key={option.value}
                    onClick={() => setSort(option.value)}
                    data-active={sort === option.value ? '' : undefined}
                  >
                    {option.label}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          </Group>
        </div>

        <div className="queue-workspace__rows">
          {visibleCards.length === 0 ? (
            <div className="queue-workspace__empty">
              <Text fw={600}>Nothing needs you right now.</Text>
              <Text size="sm" c="dimmed">
                Change the filter or check back after the next refresh.
              </Text>
            </div>
          ) : (
            visibleCards.map((card) => {
              const key = repoItemKey(card.item.repo, card.item.number);
              return (
                <QueueItemRow
                  key={key}
                  card={card}
                  href={queueSelectionHref(currentSearch, key)}
                  selected={
                    selectedCard !== undefined &&
                    repoItemKey(
                      selectedCard.item.repo,
                      selectedCard.item.number,
                    ) === key
                  }
                  muted={false}
                  onToggleMute={() => mute(key)}
                />
              );
            })
          )}
        </div>

        {mutedCards.length > 0 && (
          <details className="queue-muted-items">
            <summary>Muted ({mutedCards.length})</summary>
            <Stack gap={4} mt="xs">
              {mutedCards.map(({ item }) => {
                const key = repoItemKey(item.repo, item.number);
                return (
                  <Group key={key} justify="space-between" wrap="nowrap">
                    <Text size="xs" truncate>
                      #{item.number} {item.title}
                    </Text>
                    <Button
                      variant="subtle"
                      color="gray"
                      size="compact-xs"
                      onClick={() => unmute(key)}
                    >
                      Unmute
                    </Button>
                  </Group>
                );
              })}
            </Stack>
          </details>
        )}
      </div>

      <div className="queue-workspace__detail">
        {selectedCard ? (
          <ActionItemCard
            item={selectedCard.item}
            updatedAtLabel={selectedCard.updatedAtLabel}
            primaryAction={selectedCard.primaryAction}
            multiRepo={watchedRepos.length > 1}
            muted={false}
            onToggleMute={() =>
              mute(
                repoItemKey(selectedCard.item.repo, selectedCard.item.number),
              )
            }
            variant="workspace"
          />
        ) : explicitDetail ? (
          <div className="queue-detail-state" role="status">
            <Title order={2} size="h3">
              Item unavailable
            </Title>
            <Text c="dimmed" size="sm">
              This item is stale, filtered out, or no longer needs a decision.
            </Text>
            <Button component="a" href={backHref} variant="default">
              Back to Queue
            </Button>
          </div>
        ) : (
          <div className="queue-detail-state">
            <Title order={2} size="h3">
              Inbox clear
            </Title>
            <Text c="dimmed" size="sm">
              Select an item when new work arrives.
            </Text>
          </div>
        )}
      </div>
    </section>
  );
}
