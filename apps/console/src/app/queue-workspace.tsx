'use client';

import {
  ActionIcon,
  Anchor,
  Button,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAdjustments, IconSearch, IconX } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ActionType } from '../lib/action-items';
import {
  MAX_DECISION_SNOOZES,
  SNOOZE_DURATIONS,
} from '../lib/decision-snooze-contract';
import type { WatchedRepo } from '../lib/watched-repo';
import { ActionItemCard } from './action-item-card';
import { formatAbsoluteLocal } from './format';
import {
  type InboxCard,
  inboxCardKey,
  inboxCardMetadata,
  inboxCardSignature,
} from './inbox-card';
import { InboxMobileCommandDeck } from './inbox-mobile-command-deck';
import { NativeDecisionDetail, NativeDecisionRow } from './native-decision';
import { PersistedDetails } from './persisted-details';
import { QueueItemRow } from './queue-item-row';
import { INBOX_FILTER_REASONS } from './queue-reason';
import { useDecisionSnoozes } from './use-decision-snoozes';
import type { ReplyAction } from './work/work-actions';

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
  selectedCard: resolvedSelectedCard,
  selectedItemKey,
  watchedRepos,
  mobileDataFreshness,
  mobileScopeLabel,
  replyToWorkItem,
}: {
  cards: InboxCard[];
  /** The URL-selected item resolved from the server's full loaded item set.
   * It may no longer belong to the visible decision queue (#1173). */
  selectedCard?: InboxCard;
  selectedItemKey?: string;
  watchedRepos: WatchedRepo[];
  mobileDataFreshness?: ReactNode;
  mobileScopeLabel?: string;
  replyToWorkItem?: ReplyAction;
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
  const [replyConfirmation, setReplyConfirmation] = useState<{
    workId: string;
    title: string;
    message: string;
  }>();
  const [draftCard, setDraftCard] = useState<InboxCard>();
  const [loadingItemKey, setLoadingItemKey] = useState<string>();
  const {
    entries,
    legacy,
    pending,
    error,
    isSnoozed,
    snooze,
    unsnooze,
    importLegacy,
  } = useDecisionSnoozes();
  const [snoozeCard, setSnoozeCard] = useState<InboxCard>();
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
    const filtered = cards.filter((card) => {
      const meta = inboxCardMetadata(card);
      if (isSnoozed(inboxCardKey(card), inboxCardSignature(card))) return false;
      if (needle && !meta.search.toLowerCase().includes(needle)) return false;
      return (
        filter === 'all' || meta.actionTypes.some((type) => type === filter)
      );
    });

    return [...filtered].sort((a, b) => {
      if (sort === 'newest' || sort === 'oldest') {
        const delta =
          new Date(inboxCardMetadata(b).updatedAt).getTime() -
          new Date(inboxCardMetadata(a).updatedAt).getTime();
        return sort === 'newest' ? delta : -delta;
      }
      return inboxCardMetadata(a).rank - inboxCardMetadata(b).rank;
    });
  }, [cards, filter, isSnoozed, search, sort]);

  const cardsByKey = new Map(cards.map((card) => [inboxCardKey(card), card]));
  const snoozedItems = Object.entries(entries).filter(([key, entry]) => {
    const card = cardsByKey.get(key);
    return !card || entry.signature === inboxCardSignature(card);
  });
  const legacyAnchors = cards
    .flatMap((card) => {
      const anchor = inboxCardKey(card);
      const signature = inboxCardSignature(card);
      return !entries[anchor] &&
        Object.hasOwn(legacy, anchor) &&
        (legacy[anchor] === null || legacy[anchor] === signature)
        ? [{ anchor, signature }]
        : [];
    })
    .slice(0, MAX_DECISION_SNOOZES);
  const currentCard = selectedItemKey
    ? resolvedSelectedCard &&
      inboxCardKey(resolvedSelectedCard) === selectedItemKey
      ? resolvedSelectedCard
      : cards.find((card) => inboxCardKey(card) === selectedItemKey)
    : visibleCards[0];
  // A live update may remove/reorder the default decision while a reply is
  // being typed or admitted. Keep that identity mounted until the draft is
  // cleared; never silently transfer the reply to the new first row.
  const retainedDraft =
    draftCard &&
    (selectedItemKey === undefined ||
      selectedItemKey === inboxCardKey(draftCard));
  const selectedCard = retainedDraft
    ? ((resolvedSelectedCard &&
      inboxCardKey(resolvedSelectedCard) === inboxCardKey(draftCard)
        ? resolvedSelectedCard
        : cards.find(
            (card) => inboxCardKey(card) === inboxCardKey(draftCard),
          )) ?? draftCard)
    : currentCard;
  const draftLeftQueue =
    retainedDraft &&
    !cards.some((card) => inboxCardKey(card) === inboxCardKey(draftCard));
  const onReplyDraftChange = (hasDraft: boolean) =>
    setDraftCard(hasDraft ? selectedCard : undefined);
  const explicitDetail = selectedItemKey !== undefined;
  const backHref = queueSelectionHref(currentSearch);

  // Gmail-style list keys, global while the Inbox is mounted: j/k move the
  // selection (which IS navigation here - the detail pane follows ?item=),
  // '/' jumps to search. Guarded off inside interactive controls and when any
  // modifier is held; arrows are deliberately left alone so they keep
  // scrolling the panes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          'a[href], button, input, select, textarea, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="textbox"], [role="combobox"], [role="listbox"], [role="slider"], [role="spinbutton"], [role="switch"]',
        )
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
        (selectedCard ? inboxCardKey(selectedCard) : undefined);
      const index = visibleCards.findIndex(
        (card) => inboxCardKey(card) === currentKey,
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
      const nextKey = inboxCardKey(visibleCards[nextIndex]);
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

  useEffect(() => {
    if (loadingItemKey === selectedItemKey) setLoadingItemKey(undefined);
  }, [loadingItemKey, selectedItemKey]);

  return (
    <section
      className="queue-workspace"
      data-mobile-view={explicitDetail ? 'detail' : 'list'}
      aria-label="Decision Inbox"
    >
      <InboxMobileCommandDeck
        view={explicitDetail ? 'detail' : 'list'}
        selectedItem={
          selectedCard && !('work' in selectedCard)
            ? selectedCard.item
            : undefined
        }
        selectedIdentity={
          selectedCard && 'work' in selectedCard
            ? `${selectedCard.work.spec.target.repo} / ${selectedCard.work.id}`
            : undefined
        }
        backHref={backHref}
        scopeLabel={mobileScopeLabel}
        dataFreshness={mobileDataFreshness}
      />

      <div className="queue-workspace__list">
        {error && (
          <Text role="alert" size="sm" p="xs">
            {error}
          </Text>
        )}
        {legacyAnchors.length > 0 && (
          <Stack p="xs" gap="xs">
            <Text size="xs">
              This browser has {legacyAnchors.length} old mutes without a
              recorded owner. Import them into your account as 24-hour snoozes?
            </Text>
            <Button
              size="compact-xs"
              variant="default"
              disabled={pending}
              onClick={() => void importLegacy(legacyAnchors)}
            >
              Import this browser’s mutes
            </Button>
          </Stack>
        )}
        <div className="queue-workspace__list-header">
          <div>
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
              rightSectionWidth={search ? 52 : 28}
              rightSectionPointerEvents="all"
              value={search}
              onChange={(event) => applySearch(event.currentTarget.value)}
              placeholder="Search title, #, author, label"
              aria-label="Search the Inbox"
              leftSection={<IconSearch aria-hidden="true" size={13} />}
              rightSection={
                <Group gap={0} wrap="nowrap" justify="flex-end">
                  {search && (
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="xs"
                      aria-label="Clear search text"
                      onClick={() => applySearch('')}
                    >
                      <IconX aria-hidden="true" size={12} />
                    </ActionIcon>
                  )}
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <ActionIcon
                        variant={
                          filter === 'all' && sort === 'priority'
                            ? 'subtle'
                            : 'light'
                        }
                        color={
                          filter === 'all' && sort === 'priority'
                            ? 'gray'
                            : 'blue'
                        }
                        size="xs"
                        aria-label="Filter and sort"
                        className="queue-refine-control"
                      >
                        <IconAdjustments aria-hidden="true" size={14} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Label>Filter</Menu.Label>
                      {FILTER_OPTIONS.map((option) => (
                        <Menu.Item
                          key={option.value}
                          aria-current={
                            filter === option.value ? 'true' : undefined
                          }
                          onClick={() => applyQueueControls(option.value, sort)}
                          data-active={filter === option.value ? '' : undefined}
                        >
                          {option.label}
                        </Menu.Item>
                      ))}
                      <Menu.Divider />
                      <Menu.Label>Sort</Menu.Label>
                      {SORT_OPTIONS.map((option) => (
                        <Menu.Item
                          key={option.value}
                          aria-current={
                            sort === option.value ? 'true' : undefined
                          }
                          onClick={() =>
                            applyQueueControls(filter, option.value)
                          }
                          data-active={sort === option.value ? '' : undefined}
                        >
                          {option.label}
                        </Menu.Item>
                      ))}
                    </Menu.Dropdown>
                  </Menu>
                </Group>
              }
              className="queue-search-input"
            />
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
              const key = inboxCardKey(card);
              if ('work' in card)
                return (
                  <NativeDecisionRow
                    key={key}
                    card={card}
                    href={queueSelectionHref(currentSearch, key)}
                    selected={
                      selectedCard !== undefined &&
                      inboxCardKey(selectedCard) === key
                    }
                    onNavigate={() => setLoadingItemKey(key)}
                    onSnooze={() => setSnoozeCard(card)}
                  />
                );
              return (
                <QueueItemRow
                  key={key}
                  card={card}
                  href={queueSelectionHref(currentSearch, key)}
                  selected={
                    selectedCard !== undefined &&
                    inboxCardKey(selectedCard) === key
                  }
                  loading={loadingItemKey === key}
                  onNavigate={() => setLoadingItemKey(key)}
                  muted={false}
                  onToggleMute={() => setSnoozeCard(card)}
                />
              );
            })
          )}
        </div>

        {snoozedItems.length > 0 && (
          <PersistedDetails
            className="queue-muted-items"
            storageKey="inbox:muted"
            summary={<>Snoozed ({snoozedItems.length})</>}
          >
            <Stack gap={4} mt="xs">
              {snoozedItems.map(([key, entry]) => {
                const card = cardsByKey.get(key);
                const title = card
                  ? 'work' in card
                    ? card.work.spec.title
                    : `#${card.item.number} ${card.item.title}`
                  : key;
                return (
                  <Group key={key} justify="space-between" wrap="nowrap">
                    <Text size="xs" truncate>
                      {title}
                      <Text
                        component="span"
                        display="block"
                        size="xs"
                        c="dimmed"
                      >
                        Until{' '}
                        <time dateTime={entry.expiresAt}>
                          {formatAbsoluteLocal(entry.expiresAt)}
                        </time>
                      </Text>
                    </Text>
                    <Button
                      variant="subtle"
                      color="gray"
                      size="compact-xs"
                      disabled={pending}
                      onClick={() =>
                        void unsnooze({
                          anchor: key,
                          signature: entry.signature,
                        })
                      }
                    >
                      Unsnooze
                    </Button>
                  </Group>
                );
              })}
            </Stack>
          </PersistedDetails>
        )}
      </div>

      <div className="queue-workspace__detail">
        {draftLeftQueue && (
          <Text role="status" size="sm">
            The selected item left the queue. Your pending reply is preserved.
          </Text>
        )}
        {replyConfirmation && (
          <Stack p="md" gap="xs" data-testid="native-reply-confirmation">
            <Text fw={600}>{replyConfirmation.title}</Text>
            <Text role="status" size="sm">
              {replyConfirmation.message}
            </Text>
            <Anchor component={Link} href={`/work/${replyConfirmation.workId}`}>
              Full history of the answered work
            </Anchor>
          </Stack>
        )}
        {selectedCard && 'work' in selectedCard ? (
          <Stack gap="xs">
            <Button
              size="compact-xs"
              variant="subtle"
              disabled={pending}
              onClick={() => setSnoozeCard(selectedCard)}
            >
              Snooze decision
            </Button>
            <NativeDecisionDetail
              key={selectedCard.work.id}
              card={
                draftLeftQueue
                  ? { ...selectedCard, canReply: false }
                  : selectedCard
              }
              onReplyDraftChange={onReplyDraftChange}
              replyToWorkItem={replyToWorkItem}
              onReplyAdmitted={(message) =>
                setReplyConfirmation({
                  workId: selectedCard.work.anchor.workId,
                  title: selectedCard.work.spec.title,
                  message,
                })
              }
            />
          </Stack>
        ) : selectedCard ? (
          <ActionItemCard
            item={selectedCard.item}
            primaryAction={selectedCard.primaryAction}
            multiRepo={watchedRepos.length > 1}
            muted={isSnoozed(
              inboxCardKey(selectedCard),
              inboxCardSignature(selectedCard),
            )}
            onToggleMute={() => {
              const anchor = inboxCardKey(selectedCard);
              const signature = inboxCardSignature(selectedCard);
              if (isSnoozed(anchor, signature))
                void unsnooze({ anchor, signature });
              else setSnoozeCard(selectedCard);
            }}
            variant="workspace"
            onReplyDraftChange={onReplyDraftChange}
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
      <Modal
        opened={Boolean(snoozeCard)}
        onClose={() => {
          if (!pending) setSnoozeCard(undefined);
        }}
        title="Snooze decision"
        size="sm"
        closeOnClickOutside={!pending}
        closeOnEscape={!pending}
        withCloseButton={!pending}
      >
        <Stack gap="sm">
          <Text size="sm">
            Hide this decision only for your account, across devices. New
            activity or a changed decision brings it back sooner. No work or
            GitHub labels are changed.
          </Text>
          {error && (
            <Text role="alert" size="sm">
              {error}
            </Text>
          )}
          {SNOOZE_DURATIONS.map((duration) => (
            <Button
              key={duration.minutes}
              variant="default"
              disabled={pending}
              onClick={async () => {
                if (
                  snoozeCard &&
                  (await snooze({
                    anchor: inboxCardKey(snoozeCard),
                    signature: inboxCardSignature(snoozeCard),
                    minutes: duration.minutes,
                  }))
                )
                  setSnoozeCard(undefined);
              }}
            >
              {duration.label}
            </Button>
          ))}
        </Stack>
      </Modal>
    </section>
  );
}
