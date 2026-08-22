'use client';

import { Group, Title, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';

/**
 * Owns the collapsed/expanded state for the 'no-issue' group in
 * IssueGroupedSessions (#236). A dedicated client component - rather than
 * making the whole server-rendered issue-grouped-sessions.tsx tree client -
 * so `children` (the group's SessionTable, which pulls in
 * session-archive.ts's server-only Firestore client) is passed down already
 * rendered from the server instead of getting bundled for the browser.
 *
 * Starts collapsed: every CLI session and any issue-agent session missing an
 * issue number lands here with nothing else in common, so it tends to dwarf
 * every real issue group (the issue that asked for this reported 138 of
 * them) and pushes the groups a maintainer actually wants to scan below the
 * fold.
 */
export function NoIssueSessionGroup({
  sessionCount,
  children,
}: {
  sessionCount: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <>
      <Group gap={8} align="center" wrap="wrap">
        <UnstyledButton
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} No issue sessions`}
          data-testid="no-issue-group-toggle"
          className="sessions-no-issue-toggle"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 44,
            minHeight: 44,
          }}
        >
          {collapsed ? (
            <IconChevronRight size={16} aria-hidden="true" />
          ) : (
            <IconChevronDown size={16} aria-hidden="true" />
          )}
        </UnstyledButton>
        <Title order={3} size="h5" c="dimmed">
          No issue
        </Title>
        {sessionCount}
      </Group>
      {!collapsed && children}
    </>
  );
}
