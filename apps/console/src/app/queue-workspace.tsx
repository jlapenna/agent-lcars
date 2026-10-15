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
  Title,
} from '@mantine/core';
import { IconAdjustments, IconX } from '@tabler/icons-react';
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
import { ToolbarFoldToggle } from './console-toolbar';
import { DecisionSlaMeta } from './decision-waiting';
import { formatAbsoluteLocal } from './format';
import {
  type InboxCard,
  inboxCardAgent,
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
const AGENT_PARAM = 'agent';
const WINDOW_PARAM = 'window';
/** The toolbar's activity window (design/fleet-console.html). It defaults to
 * all, so no pending decision is ever hidden unless asked. */
const INBOX_WINDOWS = [
  { value: '1h', ms: 3_600_000 },
  { value: '24h', ms: 86_400_000 },
  { value: '7d', ms: 7 * 86_400_000 },
] as const;
const windowMs = (value: string) =>
  INBOX_WINDOWS.find((option) => option.value === value)?.ms;

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
  repoScoped = false,
  replyToWorkItem,
  toolbarStart,
  toolbarEnd,
}: {
  cards: InboxCard[];
  /** The URL-selected item resolved from the server's full loaded item set.
   * It may no longer belong to the visible decision queue (#1173). */
  selectedCard?: InboxCard;
  selectedItemKey?: string;
  watchedRepos: WatchedRepo[];
  mobileDataFreshness?: ReactNode;
  mobileScopeLabel?: string;
  /** A watched repository scopes the queue: the page's validated `?repo=`,
   * not the raw parameter, which may name no watched repository. */
  repoScoped?: boolean;
  replyToWorkItem?: ReplyAction;
  /** Server-rendered toolbar controls: the repository selector first, the
   * data freshness last (design/fleet-console.html toolbar band). */
  toolbarStart?: ReactNode;
  toolbarEnd?: ReactNode;
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
  const [agent, setAgent] = useState(() => searchParams.get(AGENT_PARAM) ?? '');
  const [activityWindow, setActivityWindow] = useState(
    () => searchParams.get(WINDOW_PARAM) ?? '',
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
    setAgent(searchParams.get(AGENT_PARAM) ?? '');
    setActivityWindow(searchParams.get(WINDOW_PARAM) ?? '');
  }, [searchParams]);

  // Mirror the controls into the URL without a server round-trip -
  // history.replaceState is the App Router's sanctioned shallow update, and
  // useSearchParams picks it up so row links carry the params too.
  const syncControlsToUrl = (
    nextFilter: QueueFilter,
    nextSort: QueueSort,
    nextSearch: string,
    nextAgent: string = agent,
    nextWindow: string = activityWindow,
  ) => {
    const params = new URLSearchParams(window.location.search);
    if (nextAgent) params.set(AGENT_PARAM, nextAgent);
    else params.delete(AGENT_PARAM);
    if (windowMs(nextWindow)) params.set(WINDOW_PARAM, nextWindow);
    else params.delete(WINDOW_PARAM);
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
  const applyAgent = (next: string) => {
    setAgent(next);
    syncControlsToUrl(filter, sort, search.trim(), next);
  };
  const applyWindow = (next: string) => {
    setActivityWindow(next);
    syncControlsToUrl(filter, sort, search.trim(), agent, next);
  };
  // A selected agent stays an option even when none of its decisions remain
  // (a live refresh, a stale bookmark), so the filter can always be cleared.
  const agentOptions = useMemo(
    () =>
      [
        ...new Set([...cards.map(inboxCardAgent), agent].filter(Boolean)),
      ].sort() as string[],
    [agent, cards],
  );

  const visibleCards = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const windowLimit = windowMs(activityWindow);
    const windowStart =
      windowLimit === undefined ? undefined : Date.now() - windowLimit;
    const filtered = cards.filter((card) => {
      const meta = inboxCardMetadata(card);
      if (isSnoozed(inboxCardKey(card), inboxCardSignature(card))) return false;
      if (needle && !meta.search.toLowerCase().includes(needle)) return false;
      if (agent && inboxCardAgent(card) !== agent) return false;
      if (
        windowStart !== undefined &&
        new Date(meta.updatedAt).getTime() < windowStart
      )
        return false;
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
  }, [activityWindow, agent, cards, filter, isSnoozed, search, sort]);

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
  const oldestCard = visibleCards.reduce<InboxCard | undefined>(
    (oldest, card) =>
      !oldest ||
      inboxCardMetadata(card).updatedAt < inboxCardMetadata(oldest).updatedAt
        ? card
        : oldest,
    undefined,
  );
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

  // Phones fold the repository and agent selects behind one toggle, as every
  // workspace toolbar does (console-toolbar.tsx). It counts the folded
  // filters that narrow the queue. The selects act through React, so the band
  // says when they are live.
  const [toolbarHydrated, setToolbarHydrated] = useState(false);
  useEffect(() => setToolbarHydrated(true), []);
  const foldedActive = (repoScoped ? 1 : 0) + (agent ? 1 : 0);

  const showDetail =
    explicitDetail || Boolean(retainedDraft) || Boolean(replyConfirmation);
  const mobileView = explicitDetail ? 'detail' : 'list';

  return (
    <section
      className="inbox-region"
      data-mobile-view={mobileView}
      aria-label="Decision Inbox"
    >
      <div
        className="console-workspace__toolbar inbox-toolbar"
        data-hydrated={toolbarHydrated ? '' : undefined}
      >
        <ToolbarFoldToggle active={foldedActive} />
        {toolbarStart}
        {agentOptions.length > 0 && (
          <select
            aria-label="Agent"
            className="console-toolbar__field console-toolbar__select inbox-agent-select"
            value={agent}
            onChange={(event) => applyAgent(event.currentTarget.value)}
          >
            <option value="">All agents</option>
            {agentOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        )}
        <div
          className="console-toolbar__segmented"
          role="radiogroup"
          aria-label="Window"
        >
          {[...INBOX_WINDOWS, { value: '' }].map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name="inbox-window"
                value={option.value}
                checked={
                  (windowMs(activityWindow) ? activityWindow : '') ===
                  option.value
                }
                onChange={() => applyWindow(option.value)}
              />
              {option.value || 'all'}
            </label>
          ))}
        </div>
        {/* The mockup's FIND field; the refine menu rides at its end. */}
        <div className="console-toolbar__field console-toolbar__search queue-search-input">
          <span className="lcars-eyebrow" aria-hidden="true">
            Find
          </span>
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(event) => applySearch(event.currentTarget.value)}
            placeholder="title, #, author, label"
            aria-label="Search the Inbox"
          />
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
                  filter === 'all' && sort === 'priority' ? 'subtle' : 'light'
                }
                color={
                  filter === 'all' && sort === 'priority' ? 'gray' : 'blue'
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
                  aria-current={filter === option.value ? 'true' : undefined}
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
                  aria-current={sort === option.value ? 'true' : undefined}
                  onClick={() => applyQueueControls(filter, option.value)}
                  data-active={sort === option.value ? '' : undefined}
                >
                  {option.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        </div>
        {toolbarEnd}
        {oldestCard && (
          <Link
            href={queueSelectionHref(currentSearch, inboxCardKey(oldestCard))}
            scroll={false}
            className="inbox-respond-oldest"
          >
            Respond to oldest
          </Link>
        )}
      </div>
      <div
        className="queue-workspace"
        data-mobile-view={mobileView}
        data-detail={showDetail ? '' : undefined}
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
                recorded owner. Import them into your account as 24-hour
                snoozes?
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
            <h2 className="ops-panel__title">Decision inbox</h2>
            <span className="ops-panel__count">{visibleCards.length}</span>
            <span className="ops-panel__meta">
              <DecisionSlaMeta
                waitingSince={visibleCards.map(
                  (card) => inboxCardMetadata(card).waitingSince,
                )}
              />
              <span className="queue-kbd-hint">
                {' '}
                · j/k to move · / to search
              </span>
            </span>
          </div>

          <div className="queue-workspace__rows">
            {visibleCards.length === 0 ? (
              <div className="queue-workspace__empty">
                <Text fw={600}>
                  {search.trim()
                    ? `No matches for “${search.trim()}”.`
                    : windowMs(activityWindow) && filter === 'all'
                      ? `No decisions with activity in the last ${activityWindow}.`
                      : filter === 'all'
                        ? 'Nothing needs you right now.'
                        : `No “${FILTER_OPTIONS.find((option) => option.value === filter)?.label}” items right now.`}
                </Text>
                <Text size="sm" c="dimmed">
                  {search.trim() ||
                  filter !== 'all' ||
                  agent ||
                  windowMs(activityWindow)
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
                  {agent && (
                    <Button
                      variant="default"
                      size="compact-sm"
                      onClick={() => applyAgent('')}
                    >
                      Show all agents
                    </Button>
                  )}
                  {windowMs(activityWindow) && (
                    <Button
                      variant="default"
                      size="compact-sm"
                      onClick={() => applyWindow('')}
                    >
                      Show all activity
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
              <Anchor
                component={Link}
                href={`/work/${replyConfirmation.workId}`}
              >
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
              description={selectedCard.description}
              lastComment={selectedCard.lastComment}
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
      </div>
    </section>
  );
}
