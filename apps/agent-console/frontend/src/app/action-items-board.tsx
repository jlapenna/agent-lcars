'use client';

import {
  Button,
  Chip,
  Group,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMemo, useState } from 'react';

import type { ActionItem } from '../lib/action-items';
import { ActionItemCard, type LiveRunSummary } from './action-item-card';

export interface BoardCard {
  item: ActionItem;
  updatedAtLabel: string;
  liveRun?: LiveRunSummary;
}

type KindFilter = 'all' | 'issue' | 'pr';

function ItemSection({
  title,
  helperText,
  cards,
  totalCount,
  emptyMessage,
  alwaysShow,
}: {
  title: string;
  helperText?: string;
  cards: BoardCard[];
  totalCount: number;
  emptyMessage: string;
  alwaysShow?: boolean;
}) {
  if (totalCount === 0 && !alwaysShow) return null;
  return (
    <div>
      <Title order={2} mb={helperText ? 4 : 'sm'}>
        {title} ({cards.length})
      </Title>
      {helperText && (
        <Text c="dimmed" size="sm" mb="sm">
          {helperText}
        </Text>
      )}
      {cards.length === 0 ? (
        <Text c="dimmed" size="sm">
          {totalCount === 0 ? emptyMessage : 'No matches in this section.'}
        </Text>
      ) : (
        <Stack gap="sm">
          {cards.map(({ item, updatedAtLabel, liveRun }) => (
            <ActionItemCard
              key={`${item.kind}-${item.number}`}
              item={item}
              updatedAtLabel={updatedAtLabel}
              liveRun={liveRun}
            />
          ))}
        </Stack>
      )}
    </div>
  );
}

export function ActionItemsBoard({
  needsAction,
  agentWorking,
  waitingOnDeploy,
  rest,
}: {
  needsAction: BoardCard[];
  agentWorking: BoardCard[];
  waitingOnDeploy: BoardCard[];
  rest: BoardCard[];
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [activeLabels, setActiveLabels] = useState<string[]>([]);

  const allBuckets = [needsAction, agentWorking, waitingOnDeploy, rest];

  const allLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const bucket of allBuckets) {
      for (const { item } of bucket) {
        for (const label of item.labels) labels.add(label);
      }
    }
    return Array.from(labels).sort();
  }, [needsAction, agentWorking, waitingOnDeploy, rest]);

  const normalizedQuery = query.trim().toLowerCase();
  const filterActive =
    normalizedQuery !== '' || kind !== 'all' || activeLabels.length > 0;

  const matches = (card: BoardCard) => {
    const { item } = card;
    if (kind !== 'all' && item.kind !== kind) return false;
    if (
      activeLabels.length > 0 &&
      !activeLabels.some((label) => item.labels.includes(label))
    ) {
      return false;
    }
    if (!normalizedQuery) return true;
    const haystack =
      `#${item.number} ${item.title} ${item.author ?? ''} ${item.labels.join(' ')}`.toLowerCase();
    return haystack.includes(normalizedQuery);
  };

  const filteredNeedsAction = needsAction.filter(matches);
  const filteredAgentWorking = agentWorking.filter(matches);
  const filteredWaitingOnDeploy = waitingOnDeploy.filter(matches);
  const filteredRest = rest.filter(matches);

  const totalItems = allBuckets.reduce((sum, bucket) => sum + bucket.length, 0);
  const totalFiltered =
    filteredNeedsAction.length +
    filteredAgentWorking.length +
    filteredWaitingOnDeploy.length +
    filteredRest.length;

  const toggleLabel = (label: string) =>
    setActiveLabels((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
    );

  const clearFilters = () => {
    setQuery('');
    setKind('all');
    setActiveLabels([]);
  };

  return (
    <Stack gap="xl">
      <Stack gap="xs">
        <Group gap="sm" wrap="wrap">
          <TextInput
            placeholder="Search by number, title, author, label…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            style={{ flex: 1, minWidth: 220 }}
          />
          <SegmentedControl
            value={kind}
            onChange={(value) => setKind(value as KindFilter)}
            data={[
              { label: 'All', value: 'all' },
              { label: 'Issues', value: 'issue' },
              { label: 'PRs', value: 'pr' },
            ]}
          />
          {filterActive && (
            <Button variant="subtle" size="compact-sm" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </Group>
        {allLabels.length > 0 && (
          <Group gap={6}>
            {allLabels.map((label) => (
              <Chip
                key={label}
                size="xs"
                checked={activeLabels.includes(label)}
                onChange={() => toggleLabel(label)}
              >
                {label}
              </Chip>
            ))}
          </Group>
        )}
        {filterActive && (
          <Text size="xs" c="dimmed">
            Showing {totalFiltered} of {totalItems} items
          </Text>
        )}
      </Stack>

      <ItemSection
        title="Needs Your Action"
        cards={filteredNeedsAction}
        totalCount={needsAction.length}
        emptyMessage="Nothing waiting on you right now."
        alwaysShow
      />

      <ItemSection
        title="Agent Working"
        helperText="The agent has the ball — nothing for you here yet."
        cards={filteredAgentWorking}
        totalCount={agentWorking.length}
        emptyMessage="No agent runs in flight."
      />

      <ItemSection
        title="Waiting on Next Deploy"
        helperText="Verified and closed automatically by the post-deploy agent after the next deploy of the affected app."
        cards={filteredWaitingOnDeploy}
        totalCount={waitingOnDeploy.length}
        emptyMessage="Nothing waiting on a deploy."
      />

      <ItemSection
        title="Everything Else"
        cards={filteredRest}
        totalCount={rest.length}
        emptyMessage="Nothing here."
      />
    </Stack>
  );
}
