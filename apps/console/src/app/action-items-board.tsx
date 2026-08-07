import { Anchor, Group, Stack, Text, Title } from '@mantine/core';

import { mostRecentSessionForItem } from '../lib/claimed-idle';
import type { CliSession } from '../lib/cli-sessions';
import { agentFleetLogin, consoleRepositoryUrl } from '../lib/deployment';
import { getWatchedRepos } from '../lib/github-client';
import { repoKey } from '../lib/watched-repo';
import type { BoardCard } from './board-card';
import { CompactItemRow } from './compact-item-row';
import { repoScopedConsoleHrefs } from './console-hrefs';
import { ItemOverflowMenu } from './item-overflow-menu';
import { PersistedDetails } from './persisted-details';
import { QueueUtilityMenu } from './queue-utility-menu';
import { QueueWorkspace } from './queue-workspace';
import { RelativeTime } from './relative-time';
import { SectionHeading } from './section-heading';
import { SignOutButton } from './sign-out-button';
import { TakeoverCommand } from './takeover-command';

export type { BoardCard } from './board-card';

/** The standalone master/detail surface for work awaiting a decision. */
export function DecisionInbox({
  yourQueue,
  selectedItemKey,
  repoFilter,
}: {
  yourQueue: BoardCard[];
  selectedItemKey?: string;
  repoFilter?: string;
}) {
  const watchedRepos = getWatchedRepos();

  return (
    <QueueWorkspace
      cards={yourQueue}
      selectedItemKey={selectedItemKey}
      watchedRepos={watchedRepos}
      mobileUtilityMenu={
        <QueueUtilityMenu
          repositoryUrl={consoleRepositoryUrl()}
          includeNavigation
          navigationHrefs={repoScopedConsoleHrefs(repoFilter)}
          signOutControl={<SignOutButton />}
        />
      }
    />
  );
}

export function BridgeSections({
  waitingOnDeploy,
  rest,
  cliSessions = [],
}: {
  waitingOnDeploy: BoardCard[];
  rest: BoardCard[];
  /** Joined against fleet-claimed rest items (see the `claimed` check
   * below) so "Everything Else" can point at whatever session last worked
   * an item, the same signal the /agents page's Claimed but Idle section
   * already surfaces (#624 - the flat list gave no hint which idle items
   * the fleet already owns vs. untouched backlog). */
  cliSessions?: CliSession[];
}) {
  return (
    <Stack gap="xl" mb="xl">
      {waitingOnDeploy.length === 0 && rest.length === 0 && (
        <Text c="dimmed" size="sm" data-testid="deck-sections-empty">
          No parked work — nothing waiting on a deploy and no idle agent items.
        </Text>
      )}
      {waitingOnDeploy.length > 0 && (
        <div>
          <SectionHeading
            title="Waiting on Next Deploy"
            count={waitingOnDeploy.length}
            description="Verified and closed automatically after the affected app’s next deploy."
          />
          <Stack gap={6}>
            {waitingOnDeploy.map(({ item }) => (
              <CompactItemRow
                key={`${repoKey(item.repo)}-${item.kind}-${item.number}`}
                item={item}
                hint={
                  <>
                    updated{' '}
                    <RelativeTime iso={item.updatedAt} variant="compact" />
                  </>
                }
                action={<ItemOverflowMenu item={item} />}
              />
            ))}
          </Stack>
        </div>
      )}

      {rest.length > 0 && (
        <PersistedDetails
          data-testid="everything-else"
          storageKey="deck:everything-else"
          summary={
            <>
              <Title order={3} size="h4" component="span">
                Everything Else ({rest.length})
              </Title>
              <Text c="dimmed" size="sm" component="span">
                {' '}
                — open agent items with nothing to do
              </Text>
            </>
          }
        >
          <Stack gap={6} mt="sm">
            {rest.map(({ item }) => {
              const claimed = item.assigneeLogins.includes(agentFleetLogin());
              const session = claimed
                ? mostRecentSessionForItem(item, cliSessions)
                : undefined;
              return (
                <Stack
                  key={`${repoKey(item.repo)}-${item.kind}-${item.number}`}
                  gap={4}
                >
                  <CompactItemRow
                    item={item}
                    hint={
                      <>
                        updated{' '}
                        <RelativeTime iso={item.updatedAt} variant="compact" />
                        {claimed && ' · claimed by the fleet'}
                      </>
                    }
                    action={
                      <Group gap={4} wrap="nowrap">
                        {session && (
                          <Anchor
                            href={`/sessions/${session.sessionId}`}
                            size="xs"
                            c="dimmed"
                            data-testid="everything-else-session-link"
                          >
                            session
                          </Anchor>
                        )}
                        <ItemOverflowMenu item={item} />
                      </Group>
                    }
                  />
                  {claimed && item.takeoverCommand && (
                    <TakeoverCommand command={item.takeoverCommand} />
                  )}
                </Stack>
              );
            })}
          </Stack>
        </PersistedDetails>
      )}
    </Stack>
  );
}
