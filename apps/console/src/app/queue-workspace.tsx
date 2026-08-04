'use client';

import { Button, Group, Menu, Stack, Text, Title } from '@mantine/core';
import {
  IconArrowsSort,
  IconChevronLeft,
  IconFilter,
} from '@tabler/icons-react';
import { useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

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
  { value: 'needs-human', label: 'Human needed' },
  { value: 'review-requested', label: 'Review requested' },
  { value: 'ready-for-agent', label: 'Ready for agent' },
  { value: 'run-failed', label: 'Run failed' },
  { value: 'merge-blocked', label: 'Merge blocked' },
  { value: 'silent-error', label: 'Silent error' },
];

const SORT_OPTIONS: Array<{ value: QueueSort; label: string }> = [
  { value: 'priority', label: 'Priority' },
  { value: 'newest', label: 'Newest update' },
  { value: 'oldest', label: 'Oldest update' },
];

// Filter/sort live in the URL (`?reason=`, `?sort=`) so a reload or a shared
// link lands on the same view - matching the `?repo=`/`?item=` params the
// Inbox already round-trips. Defaults are elided to keep bare URLs bare.
const REASON_PARAM = 'reason';
const SORT_PARAM = 'sort';

export function parseQueueFilter(value: string | null): QueueFilter {
  return FILTER_OPTIONS.some((option) => option.value === value)
    ? (value as QueueFilter)
    : 'all';
}

export function parseQueueSort(value: string | null): QueueSort {
  return SORT_OPTIONS.some((option) => option.value === value)
    ? (value as QueueSort)
    : 'priority';
}

export function queueSelectionHref(
  currentSearch: string,
  itemKey?: string,
): string {
  const params = new URLSearchParams(currentSearch);
  if (itemKey) params.set('item', itemKey);
  else params.delete('item');
  const query = params.toString();
  return query ? `/inbox?${query}` : '/inbox';
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
  const [filter, setFilter] = useState<QueueFilter>(() =>
    parseQueueFilter(searchParams.get(REASON_PARAM)),
  );
  const [sort, setSort] = useState<QueueSort>(() =>
    parseQueueSort(searchParams.get(SORT_PARAM)),
  );
  const { muted, mute, unmute } = useMutedItems();

  // Browser Back/Forward (and any same-route navigation that changes the
  // query) must resync the controls: the useState initializers above only
  // run on mount, while useSearchParams keeps updating. Our own
  // history.replaceState writes land here too - setState with an unchanged
  // value is a bail-out, so that echo is benign. (Codex review on #469.)
  useEffect(() => {
    setFilter(parseQueueFilter(searchParams.get(REASON_PARAM)));
    setSort(parseQueueSort(searchParams.get(SORT_PARAM)));
  }, [searchParams]);

  // Mirror the controls into the URL without a server round-trip -
  // history.replaceState is the App Router's sanctioned shallow update, and
  // useSearchParams picks it up so row links carry the params too.
  const applyQueueControls = (nextFilter: QueueFilter, nextSort: QueueSort) => {
    setFilter(nextFilter);
    setSort(nextSort);
    const params = new URLSearchParams(window.location.search);
    if (nextFilter === 'all') params.delete(REASON_PARAM);
    else params.set(REASON_PARAM, nextFilter);
    if (nextSort === 'priority') params.delete(SORT_PARAM);
    else params.set(SORT_PARAM, nextSort);
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      query ? `?${query}` : window.location.pathname,
    );
  };

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
              color="blue"
              leftSection={<IconChevronLeft aria-hidden="true" size={18} />}
              className="queue-mobile-back"
            >
              Inbox
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
                Inbox
              </Text>
              <Text component="span" ff="monospace" size="xs">
                {visibleCards.length.toString().padStart(2, '0')}
              </Text>
            </div>
            <Group gap={4} wrap="nowrap" className="queue-mobile-utilities">
              <QuickTaskButton
                watchedRepos={watchedRepos}
                initialRepoKey={searchParams.get('repo') ?? undefined}
                size="compact-xs"
              />
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
                  variant={filter === 'all' ? 'subtle' : 'light'}
                  color={filter === 'all' ? 'gray' : 'blue'}
                  size="compact-sm"
                  leftSection={<IconFilter aria-hidden="true" size={14} />}
                >
                  {filter === 'all'
                    ? 'Filter'
                    : FILTER_OPTIONS.find((option) => option.value === filter)
                        ?.label}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {FILTER_OPTIONS.map((option) => (
                  <Menu.Item
                    key={option.value}
                    aria-current={filter === option.value ? 'true' : undefined}
                    onClick={() => applyQueueControls(option.value, sort)}
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
                  variant={sort === 'priority' ? 'subtle' : 'light'}
                  color={sort === 'priority' ? 'gray' : 'blue'}
                  size="compact-sm"
                  leftSection={<IconArrowsSort aria-hidden="true" size={14} />}
                >
                  {sort === 'priority'
                    ? 'Sort'
                    : SORT_OPTIONS.find((option) => option.value === sort)
                        ?.label}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {SORT_OPTIONS.map((option) => (
                  <Menu.Item
                    key={option.value}
                    aria-current={sort === option.value ? 'true' : undefined}
                    onClick={() => applyQueueControls(filter, option.value)}
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
              <Text fw={600}>
                {filter === 'all'
                  ? 'Nothing needs you right now.'
                  : `No “${FILTER_OPTIONS.find((option) => option.value === filter)?.label}” items right now.`}
              </Text>
              <Text size="sm" c="dimmed">
                {filter === 'all'
                  ? 'Check back after the next refresh.'
                  : 'Other items may be hidden by the active filter.'}
              </Text>
              {filter !== 'all' && (
                <Button
                  variant="default"
                  size="compact-sm"
                  onClick={() => applyQueueControls('all', sort)}
                >
                  Show all reasons
                </Button>
              )}
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
              Back to Inbox
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
