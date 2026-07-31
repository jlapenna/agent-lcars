import { Group, Stack, Text, Title } from '@mantine/core';

import { getWatchedRepos } from '../lib/github-client';
import { pipelineForLabels } from '../lib/primary-action';
import { repoKey } from '../lib/watched-repo';
import type { BoardCard } from './board-card';
import { CompactItemRow } from './compact-item-row';
import { ItemOverflowMenu } from './item-overflow-menu';
import { QueueUtilityMenu } from './queue-utility-menu';
import { QueueWorkspace } from './queue-workspace';
import { RetriggerButton } from './retrigger-button';
import { SectionHeading } from './section-heading';
import { SignOutButton } from './sign-out-button';

export type { BoardCard } from './board-card';

/** The standalone master/detail surface for work awaiting a decision. */
export function DecisionInbox({
  yourQueue,
  selectedItemKey,
}: {
  yourQueue: BoardCard[];
  selectedItemKey?: string;
}) {
  const watchedRepos = getWatchedRepos();

  return (
    <QueueWorkspace
      cards={yourQueue}
      selectedItemKey={selectedItemKey}
      watchedRepos={watchedRepos}
      mobileUtilityMenu={
        <QueueUtilityMenu
          includeNavigation
          signOutControl={<SignOutButton />}
        />
      }
    />
  );
}

export function CommandDeckSections({
  handedBack,
  waitingOnDeploy,
  rest,
}: {
  handedBack: BoardCard[];
  waitingOnDeploy: BoardCard[];
  rest: BoardCard[];
}) {
  return (
    <Stack gap="xl" mb="xl">
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
