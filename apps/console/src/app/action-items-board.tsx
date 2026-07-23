import { Group, Stack, Text, Title } from '@mantine/core';

import type { ActionItem } from '../lib/action-items';
import { getWatchedRepos } from '../lib/github-client';
import { pipelineForLabels, type PrimaryAction } from '../lib/primary-action';
import { repoKey } from '../lib/watched-repo';
import { ActionItemCard } from './action-item-card';
import { CompactItemRow } from './compact-item-row';
import { ItemOverflowMenu } from './item-overflow-menu';
import { RetriggerButton } from './retrigger-button';

export interface BoardCard {
  item: ActionItem;
  updatedAtLabel: string;
  primaryAction?: PrimaryAction;
}

function SectionHeading({
  title,
  count,
  description,
  primary = false,
}: {
  title: string;
  count: number;
  description: string;
  primary?: boolean;
}) {
  return (
    <>
      <Title order={primary ? 2 : 3} size={primary ? undefined : 'h4'} mb={2}>
        {title}
      </Title>
      <Text c="dimmed" size="sm" mb="sm">
        {count} {count === 1 ? 'item' : 'items'} · {description}
      </Text>
    </>
  );
}

/**
 * The task board, tiered by whose move it is. Only "Your Queue" gets
 * full-weight cards with actions; every other tier renders one-line rows,
 * and the no-ones-move tier stays collapsed. No search/filter chrome - at
 * this queue size (tens of items) the filters were more pixels than the
 * items, and GitHub itself is the browsing surface.
 */
export function ActionItemsBoard({
  yourQueue,
  handedBack,
  waitingOnDeploy,
  rest,
}: {
  yourQueue: BoardCard[];
  handedBack: BoardCard[];
  waitingOnDeploy: BoardCard[];
  rest: BoardCard[];
}) {
  // Server component - safe to resolve here directly, then thread down as a
  // plain boolean prop to ActionItemCard (a client component that can't
  // call getWatchedRepos() itself - see its own doc comment).
  const multiRepo = getWatchedRepos().length > 1;

  return (
    <Stack gap="xl">
      <div>
        <SectionHeading
          title="Your Queue"
          count={yourQueue.length}
          description="Needs your decision or response."
          primary
        />
        {yourQueue.length === 0 ? (
          <Text c="dimmed" size="sm">
            Nothing needs you right now.
          </Text>
        ) : (
          <Stack gap="sm">
            {yourQueue.map(({ item, updatedAtLabel, primaryAction }) => (
              <ActionItemCard
                key={`${repoKey(item.repo)}-${item.kind}-${item.number}`}
                item={item}
                updatedAtLabel={updatedAtLabel}
                primaryAction={primaryAction}
                multiRepo={multiRepo}
              />
            ))}
          </Stack>
        )}
      </div>

      {handedBack.length > 0 && (
        <div>
          <SectionHeading
            title="Handed Back"
            count={handedBack.length}
            description="You answered; the agent hasn’t picked these back up yet."
          />
          <Stack gap={6}>
            {handedBack.map(({ item, updatedAtLabel }) => (
              <CompactItemRow
                key={`${repoKey(item.repo)}-${item.kind}-${item.number}`}
                item={item}
                hint={`you replied · updated ${updatedAtLabel}`}
                action={
                  <Group gap={4} wrap="nowrap">
                    {item.kind === 'issue' &&
                      (item.labels.includes('claude') ||
                        item.labels.includes('codex') ||
                        item.labels.includes('opencode')) && (
                        <RetriggerButton
                          repo={item.repo}
                          issueNumber={item.number}
                          pipeline={pipelineForLabels(item.labels)}
                          size="compact-xs"
                        />
                      )}
                    <ItemOverflowMenu item={item} />
                  </Group>
                }
              />
            ))}
          </Stack>
        </div>
      )}

      {waitingOnDeploy.length > 0 && (
        <div>
          <SectionHeading
            title="Waiting on Next Deploy"
            count={waitingOnDeploy.length}
            description="Verified and closed automatically after the affected app’s next deploy."
          />
          <Stack gap={6}>
            {waitingOnDeploy.map(({ item, updatedAtLabel }) => (
              <CompactItemRow
                key={`${repoKey(item.repo)}-${item.kind}-${item.number}`}
                item={item}
                hint={`updated ${updatedAtLabel}`}
                action={<ItemOverflowMenu item={item} />}
              />
            ))}
          </Stack>
        </div>
      )}

      {rest.length > 0 && (
        <details data-testid="everything-else">
          <summary style={{ cursor: 'pointer' }}>
            <Title order={3} size="h4" component="span">
              Everything Else ({rest.length})
            </Title>
            <Text c="dimmed" size="sm" component="span">
              {' '}
              — open agent items with nothing to do
            </Text>
          </summary>
          <Stack gap={6} mt="sm">
            {rest.map(({ item, updatedAtLabel }) => (
              <CompactItemRow
                key={`${repoKey(item.repo)}-${item.kind}-${item.number}`}
                item={item}
                hint={`updated ${updatedAtLabel}`}
                action={<ItemOverflowMenu item={item} />}
              />
            ))}
          </Stack>
        </details>
      )}
    </Stack>
  );
}
