'use client';

import {
  ActionIcon,
  Button,
  Group,
  Menu,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import {
  IconArrowsSort,
  IconChevronLeft,
  IconFilter,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ActionType } from '../lib/action-items';
import type { WatchedRepo } from '../lib/watched-repo';
import { repoItemKey } from '../lib/watched-repo';
import { ActionItemCard } from './action-item-card';
import type { BoardCard } from './board-card';
import { PersistedDetails } from './persisted-details';
import { QueueItemRow } from './queue-item-row';
import { INBOX_FILTER_REASONS, queueReasonFor } from './queue-reason';
import { QuickTaskButton } from './quick-task-button';
import { RefreshButton } from './refresh-button';
import { muteSignatureFor, useMutedItems } from './use-muted-items';

type QueueFilter = 'all' | ActionType;
type QueueSort = 'priority' | 'newest' | 'oldest';

// Derived from queue-reason.ts's canonical map so the menu can never
// drift from what the rows and cards call the same reason.
const FILTER_OPTIONS: Array<{ value: QueueFilter; label: string }> = [
  { value: 'all', label: 'All reasons' },
  ...INBOX_FILTER_REASONS.map((reason) => ({
    value: reason.type as QueueFilter,
    label: reason.label,
  })),
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
const SEARCH_PARAM = 'q';

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
  const [search, setSearch] = useState(
    () => searchParams.get(SEARCH_PARAM) ?? '',
  );
  const { isMuted, mute, unmute } = useMutedItems();
  const router = useRouter();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const keyboardNavigated = useRef(false);
  // Where the last j/k already sent us: router.replace is asynchronous, so
  // key-repeat arriving before selectedItemKey updates must step from this
  // pending target, not the stale rendered selection (Codex review #495).
  const pendingItemKey = useRef<string | null>(null);

  // Browser Back/Forward (and any same-route navigation that changes the
  // query) must resync the controls: the useState initializers above only
  // run on mount, while useSearchParams keeps updating. Our own
  // history.replaceState writes land here too - setState with an unchanged
  // value is a bail-out, so that echo is benign. (Codex review on #469.)
  useEffect(() => {
    setFilter(parseQueueFilter(searchParams.get(REASON_PARAM)));
    setSort(parseQueueSort(searchParams.get(SORT_PARAM)));
    setSearch(searchParams.get(SEARCH_PARAM) ?? '');
  }, [searchParams]);

  // Mirror the controls into the URL without a server round-trip -
  // history.replaceState is the App Router's sanctioned shallow update, and
  // useSearchParams picks it up so row links carry the params too.
  const syncControlsToUrl = (
    nextFilter: QueueFilter,
    nextSort: QueueSort,
    nextSearch: string,
  ) => {
    const params = new URLSearchParams(window.location.search);
    if (nextFilter === 'all') params.delete(REASON_PARAM);
    else params.set(REASON_PARAM, nextFilter);
    if (nextSort === 'priority') params.delete(SORT_PARAM);
    else params.set(SORT_PARAM, nextSort);
    if (nextSearch) params.set(SEARCH_PARAM, nextSearch);
    else params.delete(SEARCH_PARAM);
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      query ? `?${query}` : window.location.pathname,
    );
  };
  const applyQueueControls = (nextFilter: QueueFilter, nextSort: QueueSort) => {
    setFilter(nextFilter);
    setSort(nextSort);
    syncControlsToUrl(nextFilter, nextSort, search);
  };
  const applySearch = (next: string) => {
    setSearch(next);
    syncControlsToUrl(filter, sort, next.trim());
  };

  const visibleCards = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matchesSearch = (item: BoardCard['item']) =>
      !needle ||
      item.title.toLowerCase().includes(needle) ||
      String(item.number).includes(needle.replace(/^#/, '')) ||
      (item.author ?? '').toLowerCase().includes(needle) ||
      item.labels.some((label) => label.toLowerCase().includes(needle));
    const filtered = cards.filter(({ item }) => {
      if (isMuted(repoItemKey(item.repo, item.number), muteSignatureFor(item)))
        return false;
      if (!matchesSearch(item)) return false;
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
  }, [cards, filter, isMuted, search, sort]);

  const mutedCards = cards.filter(({ item }) =>
    isMuted(repoItemKey(item.repo, item.number), muteSignatureFor(item)),
  );
  const selectedCard = selectedItemKey
    ? cards.find(
        ({ item }) => repoItemKey(item.repo, item.number) === selectedItemKey,
      )
    : visibleCards[0];
  const explicitDetail = selectedItemKey !== undefined;
  const backHref = queueSelectionHref(currentSearch);

  // Gmail-style list keys, global while the Inbox is mounted: j/k move the
  // selection (which IS navigation here - the detail pane follows ?item=),
  // '/' jumps to search. Guarded off inside inputs/textareas and when any
  // modifier is held; arrows are deliberately left alone so they keep
  // scrolling the panes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === '/') {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      const isNext = event.key === 'j';
      const isPrev = event.key === 'k';
      if ((!isNext && !isPrev) || visibleCards.length === 0) return;
      const currentKey =
        pendingItemKey.current ??
        (selectedCard
          ? repoItemKey(selectedCard.item.repo, selectedCard.item.number)
          : undefined);
      const index = visibleCards.findIndex(
        ({ item }) => repoItemKey(item.repo, item.number) === currentKey,
      );
      const nextIndex =
        index === -1
          ? 0
          : Math.min(
              Math.max(index + (isNext ? 1 : -1), 0),
              visibleCards.length - 1,
            );
      if (nextIndex === index) return;
      event.preventDefault();
      keyboardNavigated.current = true;
      const nextKey = repoItemKey(
        visibleCards[nextIndex].item.repo,
        visibleCards[nextIndex].item.number,
      );
      pendingItemKey.current = nextKey;
      // replace, not push: holding j shouldn't bury the back button under
      // one history entry per row skimmed.
      router.replace(queueSelectionHref(currentSearch, nextKey), {
        scroll: false,
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visibleCards, selectedCard, currentSearch, router]);

  // Keep a keyboard-moved selection visible in the scrollable list; mouse
  // selection never needs this (the row was already under the pointer).
  useEffect(() => {
    // The router caught up with the last keyboard move; step from the
    // rendered selection again.
    if (pendingItemKey.current === selectedItemKey) {
      pendingItemKey.current = null;
    }
    if (!keyboardNavigated.current) return;
    keyboardNavigated.current = false;
    document
      .querySelector('.queue-item-row[data-selected]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedItemKey]);

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
              <Text
                component="span"
                size="xs"
                c="dimmed"
                className="queue-kbd-hint"
              >
                {' '}
                · j/k to move · / to search
              </Text>
            </Text>
          </div>
          <Group gap={6} className="queue-list-controls">
            <TextInput
              ref={searchInputRef}
              size="xs"
              rightSectionPointerEvents="all"
              value={search}
              onChange={(event) => applySearch(event.currentTarget.value)}
              placeholder="Search title, #, author, label"
              aria-label="Search the Inbox"
              leftSection={<IconSearch aria-hidden="true" size={13} />}
              rightSection={
                search ? (
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="xs"
                    aria-label="Clear search text"
                    onClick={() => applySearch('')}
                  >
                    <IconX aria-hidden="true" size={12} />
                  </ActionIcon>
                ) : undefined
              }
              className="queue-search-input"
            />
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
                {search.trim()
                  ? `No matches for “${search.trim()}”.`
                  : filter === 'all'
                    ? 'Nothing needs you right now.'
                    : `No “${FILTER_OPTIONS.find((option) => option.value === filter)?.label}” items right now.`}
              </Text>
              <Text size="sm" c="dimmed">
                {search.trim() || filter !== 'all'
                  ? 'Other items may be hidden by the search or active filter.'
                  : 'Check back after the next refresh.'}
              </Text>
              <Group gap="xs">
                {search.trim() && (
                  <Button
                    variant="default"
                    size="compact-sm"
                    onClick={() => applySearch('')}
                  >
                    Clear search
                  </Button>
                )}
                {filter !== 'all' && (
                  <Button
                    variant="default"
                    size="compact-sm"
                    onClick={() => applyQueueControls('all', sort)}
                  >
                    Show all reasons
                  </Button>
                )}
              </Group>
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
                  onToggleMute={() => mute(key, muteSignatureFor(card.item))}
                />
              );
            })
          )}
        </div>

        {mutedCards.length > 0 && (
          <PersistedDetails
            className="queue-muted-items"
            storageKey="inbox:muted"
            summary={<>Muted ({mutedCards.length})</>}
          >
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
          </PersistedDetails>
        )}
      </div>

      <div className="queue-workspace__detail">
        {selectedCard ? (
          <ActionItemCard
            item={selectedCard.item}
            primaryAction={selectedCard.primaryAction}
            multiRepo={watchedRepos.length > 1}
            muted={false}
            onToggleMute={() =>
              mute(
                repoItemKey(selectedCard.item.repo, selectedCard.item.number),
                muteSignatureFor(selectedCard.item),
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
