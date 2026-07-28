import { Anchor, Group, Stack, Text, Title } from '@mantine/core';

import { primaryWatchedRepo, repoItemKey } from '../../lib/github-client';
import type { IssueSessionGroup } from '../../lib/session-issue-groups';
import { RepoBadge } from '../agent-activity-panel';
import { SessionTable } from './session-table';

/** Mirrors ledger-tables.tsx's issueRowKey - the bare issue number collides
 * once two watched repos can each have their own #42. */
function groupKey(group: IssueSessionGroup): string | number {
  return group.issueNumber === 'no-issue'
    ? group.issueNumber
    : repoItemKey(group.repo ?? primaryWatchedRepo(), group.issueNumber);
}

function GroupHeading({ group }: { group: IssueSessionGroup }) {
  return (
    <Group gap={8} align="center" wrap="wrap">
      {group.issueNumber === 'no-issue' ? (
        <Title order={3} size="h5" c="dimmed">
          No issue
        </Title>
      ) : (
        <>
          <Title order={3} size="h5">
            {group.issueUrl ? (
              <Anchor
                href={group.issueUrl}
                target="_blank"
                rel="noreferrer"
                underline="hover"
                c="inherit"
              >
                #{group.issueNumber}
              </Anchor>
            ) : (
              `#${group.issueNumber}`
            )}
          </Title>
          {group.repo && <RepoBadge repo={group.repo} />}
        </>
      )}
      <Text size="xs" c="dimmed">
        {group.sessions.length} session{group.sessions.length === 1 ? '' : 's'}
      </Text>
    </Group>
  );
}

/**
 * The archive's "group by issue" view (#177, `?view=by-issue`) - the flat
 * SessionTable re-sectioned so every session an issue took (across however
 * many resumed/parked/handed-off sessions) reads as one group instead of
 * scattered rows a maintainer has to mentally re-assemble. Reuses
 * SessionTable unmodified per group (rather than duplicating its
 * table/card rendering) so both views always agree on how a single session
 * row looks.
 */
export function IssueGroupedSessions({
  groups,
}: {
  groups: IssueSessionGroup[];
}) {
  if (groups.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="session-table-empty">
        No sessions in this window.
      </Text>
    );
  }

  return (
    <Stack gap="xl" data-testid="issue-grouped-sessions">
      {groups.map((group) => (
        <Stack
          key={groupKey(group)}
          gap="xs"
          data-testid={`issue-group-${groupKey(group)}`}
        >
          <GroupHeading group={group} />
          <SessionTable rows={group.sessions} />
        </Stack>
      ))}
    </Stack>
  );
}
