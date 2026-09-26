import { Badge, Card, Group, Stack } from '@mantine/core';
import type { ReactNode } from 'react';

import { getWatchedRepos } from '../lib/github-client';
import { repoKey } from '../lib/watched-repo';
import { RepoBadge } from './agent-activity-panel';
import type { BoardCard } from './board-card';
import { BridgePaneLink } from './bridge-pane-link';
import { bridgeSelectionHref, itemKey } from './bridge-selection';
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

/**
 * One Bridge section of idle GitHub items parked on a wait. Every row gets
 * the same shape - kind, repo, a selectable title, and one direct link -
 * so "Waiting on Deploy" and "Blocked" cannot drift into two designs for
 * the same kind of row.
 */
function IdleItemsSection({
  cards,
  title,
  description,
  className,
  testId,
  rowTestIdPrefix,
  repoFilterKey,
}: {
  cards: BoardCard[];
  title: string;
  description: string;
  className: string;
  testId: string;
  rowTestIdPrefix: string;
  repoFilterKey?: string;
}) {
  if (cards.length === 0) return null;

  return (
    <Card
      withBorder
      padding="md"
      mb="xl"
      className={`lcars-panel ${className}`}
      data-testid={testId}
    >
      <SectionHeading
        title={title}
        count={cards.length}
        description={description}
      />
      <Stack gap={0}>
        {cards.map(({ item }) => (
          <div
            className="operations-row"
            key={`${repoKey(item.repo)}-${item.kind}-${item.number}`}
            data-testid={`${rowTestIdPrefix}-${item.number}`}
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
              <BridgePaneLink
                mobileHref={item.url}
                paneHref={bridgeSelectionHref(itemKey(item), repoFilterKey)}
                target="_blank"
                rel="noreferrer"
                size="sm"
                fw={600}
                c="inherit"
                td="none"
                truncate
                className="bridge-row-select"
              >
                #{item.number} {item.title}
              </BridgePaneLink>
            </Group>
            <BridgePaneLink
              mobileHref={item.url}
              paneHref={bridgeSelectionHref(itemKey(item), repoFilterKey)}
              target="_blank"
              rel="noreferrer"
              size="sm"
              className="operations-primary-action"
            >
              Open {item.kind === 'pr' ? 'PR' : 'issue'} ↗
            </BridgePaneLink>
          </div>
        ))}
      </Stack>
    </Card>
  );
}

/**
 * The Bridge's wait sections. Named distinctly from the native Work
 * orchestrator's "Stopped work" (see `ParkedWorkPanel`) - a GitHub item idle
 * only because it's waiting on the next deploy, or on an external
 * dependency, is not the same state as an agent explicitly parking itself
 * needing a human, and reusing that label for both made the Bridge look like
 * it was reporting the same parked work twice (#1677).
 *
 * "Blocked" is `status:blocked`, which the label contract keeps distinct from
 * `status:needs-human`: nobody has a decision to make, so the item is not in
 * the Inbox, but it is real open work the Bridge should still account for
 * rather than leaving it to look like a stale fleet claim.
 */
export function BridgeSections({
  waitingOnDeploy,
  blocked = [],
  repoFilterKey,
}: {
  waitingOnDeploy: BoardCard[];
  blocked?: BoardCard[];
  repoFilterKey?: string;
}) {
  return (
    <>
      <IdleItemsSection
        cards={waitingOnDeploy}
        title="Waiting on Deploy"
        description="Waiting for the next deploy before verification can continue."
        className="waiting-on-deploy"
        testId="waiting-on-deploy"
        rowTestIdPrefix="deploy-wait-item"
        repoFilterKey={repoFilterKey}
      />
      <IdleItemsSection
        cards={blocked}
        title="Blocked"
        description="Waiting on an external dependency or prerequisite; nothing to decide yet."
        className="blocked-work"
        testId="blocked-work"
        rowTestIdPrefix="blocked-item"
        repoFilterKey={repoFilterKey}
      />
    </>
  );
}
