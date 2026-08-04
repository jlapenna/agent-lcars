'use client';

import { Anchor, Badge, Button, Group, Stack, Text } from '@mantine/core';

import { repoDisplayName, repoItemKey } from '../lib/watched-repo';
import { ActionItemCard } from './action-item-card';
import type { BoardCard } from './board-card';
import { SectionHeading } from './section-heading';
import { muteSignatureFor, useMutedItems } from './use-muted-items';

/**
 * A muted row's two-line summary. Deliberately NOT CompactItemRow: that
 * component's RepoBadge calls getWatchedRepos() (server-only env access)
 * straight from its render body, so importing it here would drag
 * agent-activity-panel.tsx - and, through it, github-client.ts's Node-only
 * deps (firebase-admin, google-auth-library) - into the client bundle and
 * fail the build the same way a direct import would (#59). `multiRepo`
 * arrives as a prop instead, same as ActionItemCard already does. The second
 * line always renders, matching CompactItemRow's own two-line shape (#169).
 */
function MutedItemRow({
  item,
  hint,
  multiRepo,
  onUnmute,
}: {
  item: BoardCard['item'];
  hint: string;
  multiRepo: boolean;
  onUnmute: () => void;
}) {
  return (
    <Stack gap={2}>
      <Group gap="xs" wrap="wrap" align="center">
        <Badge
          variant="outline"
          color="gray"
          size="xs"
          style={{ flexShrink: 0 }}
        >
          {item.kind === 'pr' ? 'PR' : 'Issue'}
        </Badge>
        {multiRepo && (
          <Badge
            variant="outline"
            color="gray"
            size="xs"
            style={{ flexShrink: 0 }}
            data-testid="repo-badge"
          >
            {repoDisplayName(item.repo)}
          </Badge>
        )}
        <Anchor
          href={item.url}
          target="_blank"
          rel="noreferrer"
          size="sm"
          c="inherit"
          style={{ minWidth: 180, flex: '1 1 18rem' }}
        >
          #{item.number} {item.title}
        </Anchor>
      </Group>
      <Group gap="xs" wrap="wrap" align="center">
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
          {hint}
          {item.author && ` · by ${item.author}`}
          {item.labels.length > 0 && ` · ${item.labels.join(', ')}`}
        </Text>
        <Button variant="default" size="compact-xs" onClick={onUnmute}>
          Unmute
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * "Your Queue"'s heading + list, split out of ActionItemsBoard (a server
 * component) because muting is per-browser client state (#59, see
 * use-muted-items.ts) - the count in the heading and which items render as
 * full cards both need to react to it. A muted item drops out of the count
 * and the list entirely, collapsing into a "Muted" row below it can be
 * unmuted from - it never touches GitHub, so nothing else that reads this
 * item's labels/assignees (another viewer, an agent run) is affected.
 */
export function YourQueueSection({
  cards,
  multiRepo,
}: {
  cards: BoardCard[];
  multiRepo: boolean;
}) {
  const { isMuted: isKeyMuted, mute, unmute } = useMutedItems();

  const isMuted = (item: BoardCard['item']) =>
    isKeyMuted(repoItemKey(item.repo, item.number), muteSignatureFor(item));

  const visible = cards.filter(({ item }) => !isMuted(item));
  const mutedCards = cards.filter(({ item }) => isMuted(item));

  return (
    <>
      <SectionHeading
        title="Your Queue"
        count={visible.length}
        description="Needs your decision or response."
        primary
      />
      {visible.length === 0 ? (
        <Text c="dimmed" size="sm">
          Nothing needs you right now.
        </Text>
      ) : (
        <Stack gap="sm">
          {visible.map(({ item, updatedAtLabel, primaryAction }) => (
            <ActionItemCard
              key={`${item.repo.owner}/${item.repo.name}-${item.kind}-${item.number}`}
              item={item}
              updatedAtLabel={updatedAtLabel}
              primaryAction={primaryAction}
              multiRepo={multiRepo}
              muted={false}
              onToggleMute={() =>
                mute(
                  repoItemKey(item.repo, item.number),
                  muteSignatureFor(item),
                )
              }
            />
          ))}
        </Stack>
      )}

      {mutedCards.length > 0 && (
        <details data-testid="muted-queue-items">
          <summary style={{ cursor: 'pointer' }}>
            <Text component="span" fw={600} size="sm">
              Muted ({mutedCards.length})
            </Text>
          </summary>
          <Stack gap={6} mt="sm">
            {mutedCards.map(({ item, updatedAtLabel }) => (
              <MutedItemRow
                key={`${item.repo.owner}/${item.repo.name}-${item.kind}-${item.number}`}
                item={item}
                hint={`updated ${updatedAtLabel}`}
                multiRepo={multiRepo}
                onUnmute={() => unmute(repoItemKey(item.repo, item.number))}
              />
            ))}
          </Stack>
        </details>
      )}
    </>
  );
}
