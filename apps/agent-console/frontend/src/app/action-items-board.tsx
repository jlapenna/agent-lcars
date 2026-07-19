import { Group, Stack, Text, Title } from '@mantine/core';

import type { ActionItem } from '../lib/action-items';
import { pipelineForLabels, type PrimaryAction } from '../lib/primary-action';
import { ActionItemCard } from './action-item-card';
import { CompactItemRow } from './compact-item-row';
import { ItemOverflowMenu } from './item-overflow-menu';
import { RetriggerButton } from './retrigger-button';

export interface BoardCard {
  item: ActionItem;
  updatedAtLabel: string;
  primaryAction?: PrimaryAction;
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
  return (
    <Stack gap="xl">
      <div>
        <Title order={2} mb="sm">
          Your Queue ({yourQueue.length})
        </Title>
        {yourQueue.length === 0 ? (
          <Text c="dimmed" size="sm">
            Nothing needs you right now.
          </Text>
        ) : (
          <Stack gap="sm">
            {yourQueue.map(({ item, updatedAtLabel, primaryAction }) => (
              <ActionItemCard
                key={`${item.kind}-${item.number}`}
                item={item}
                updatedAtLabel={updatedAtLabel}
                primaryAction={primaryAction}
              />
            ))}
          </Stack>
        )}
      </div>

      {handedBack.length > 0 && (
        <div>
          <Title order={3} size="h4" mb={4}>
            Handed Back ({handedBack.length})
          </Title>
          <Text c="dimmed" size="sm" mb="sm">
            You answered; the agent hasn&rsquo;t picked these back up yet.
            Retrigger one if it&rsquo;s stalled.
          </Text>
          <Stack gap={6}>
            {handedBack.map(({ item, updatedAtLabel }) => (
              <CompactItemRow
                key={`${item.kind}-${item.number}`}
                item={item}
                hint={`you replied · updated ${updatedAtLabel}`}
                action={
                  <Group gap={4} wrap="nowrap">
                    {item.kind === 'issue' &&
                      (item.labels.includes('claude') ||
                        item.labels.includes('opencode')) && (
                        <RetriggerButton
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
          <Title order={3} size="h4" mb={4}>
            Waiting on Next Deploy ({waitingOnDeploy.length})
          </Title>
          <Text c="dimmed" size="sm" mb="sm">
            Verified and closed automatically by the post-deploy agent after the
            next deploy of the affected app.
          </Text>
          <Stack gap={6}>
            {waitingOnDeploy.map(({ item, updatedAtLabel }) => (
              <CompactItemRow
                key={`${item.kind}-${item.number}`}
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
                key={`${item.kind}-${item.number}`}
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
