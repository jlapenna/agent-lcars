import { Anchor, Badge, Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';

import { getWatchedRepos } from '../lib/github-client';
import { repoKey } from '../lib/watched-repo';
import { RepoBadge } from './agent-activity-panel';
import type { BoardCard } from './board-card';
import { QueueWorkspace } from './queue-workspace';
import { SectionHeading } from './section-heading';

export type { BoardCard } from './board-card';

/** The standalone master/detail surface for work awaiting a decision. */
export function DecisionInbox({
  yourQueue,
  selectedCard,
  selectedItemKey,
  mobileDataFreshness,
  mobileScopeLabel,
}: {
  yourQueue: BoardCard[];
  selectedCard?: BoardCard;
  selectedItemKey?: string;
  mobileDataFreshness?: ReactNode;
  mobileScopeLabel?: string;
}) {
  const watchedRepos = getWatchedRepos();

  return (
    <QueueWorkspace
      cards={yourQueue}
      selectedCard={selectedCard}
      selectedItemKey={selectedItemKey}
      watchedRepos={watchedRepos}
      mobileDataFreshness={mobileDataFreshness}
      mobileScopeLabel={mobileScopeLabel}
    />
  );
}

export function BridgeSections({
  waitingOnDeploy,
}: {
  waitingOnDeploy: BoardCard[];
}) {
  if (waitingOnDeploy.length === 0) return null;

  return (
    <section className="parked-work" data-testid="parked-work">
      <SectionHeading
        title="Parked Work"
        count={waitingOnDeploy.length}
        description="Waiting for the next deploy before verification can continue."
      />
      <Stack gap={0} mb="xl">
        {waitingOnDeploy.map(({ item }) => (
          <div
            className="operations-row"
            key={`${repoKey(item.repo)}-${item.kind}-${item.number}`}
            data-testid={`parked-item-${item.number}`}
          >
            <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
              <Badge
                variant="outline"
                color="gray"
                size="xs"
                style={{ flexShrink: 0 }}
              >
                {item.kind === 'pr' ? 'PR' : 'Issue'}
              </Badge>
              <RepoBadge repo={item.repo} />
              <Text size="sm" fw={600} truncate>
                #{item.number} {item.title}
              </Text>
            </Group>
            <Anchor
              href={item.url}
              target="_blank"
              rel="noreferrer"
              size="sm"
              className="operations-primary-action"
            >
              Open {item.kind === 'pr' ? 'PR' : 'issue'} ↗
            </Anchor>
          </div>
        ))}
      </Stack>
    </section>
  );
}
