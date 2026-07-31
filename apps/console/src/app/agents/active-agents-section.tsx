import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import { Card, Stack, Text, Title } from '@mantine/core';

import type { ActionItem } from '../../lib/action-items';
import type { AgentRun } from '../../lib/agent-activity';
import { findItemForSession } from '../../lib/claimed-idle';
import type { CliSession } from '../../lib/cli-sessions';
import {
  CliSessionRow,
  LiveRunGroupList,
  type RunItemRef,
} from '../agent-activity-panel';
import { lcarsPanelStyle } from '../lcars';

/**
 * One row per actor currently working something, agent by agent - the
 * fleet-focused counterpart to the home page's maintainer-focused "In
 * Flight" panel (see agent-activity-panel.tsx). Reuses the exact same
 * grouped-run/session rendering (LiveRunGroupList, CliSessionRow) for
 * visual consistency; the only addition here is surfacing a CLI session's
 * takeover command when it's working a claimed item that has one (joined
 * via findItemForSession/sessionReferencesItemNumber - see
 * claimed-idle.ts).
 */
export function ActiveAgentsSection({
  liveRuns,
  itemsByRunId,
  activeSessions,
  items,
  sessionsByRunId = {},
}: {
  liveRuns: AgentRun[];
  itemsByRunId: Record<number, RunItemRef>;
  activeSessions: CliSession[];
  items: ActionItem[];
  /** Joined `issue-agent` session docs, keyed by `AgentRun.id` - see
   * `indexSessionsByNumericRunId` in run-classification.ts. */
  sessionsByRunId?: Record<number, IssueAgentSessionDoc>;
}) {
  const hasActivity = liveRuns.length > 0 || activeSessions.length > 0;

  return (
    <Card
      withBorder
      radius="md"
      padding="md"
      mb="xl"
      data-testid="active-agents-section"
      className="lcars-panel agents-panel agents-panel--active"
      style={lcarsPanelStyle('periwinkle')}
    >
      <Stack gap="sm">
        <Title order={2} size="h4">
          Active Agents
        </Title>

        {!hasActivity && (
          <Text size="sm" c="dimmed">
            No agent runs or CLI sessions in flight.
          </Text>
        )}

        {liveRuns.length > 0 && (
          <LiveRunGroupList
            liveRuns={liveRuns}
            itemsByRunId={itemsByRunId}
            sessionsByRunId={sessionsByRunId}
          />
        )}

        {activeSessions.length > 0 && (
          <Stack gap="xs">
            {activeSessions.map((session) => (
              <CliSessionRow
                key={session.sessionId}
                session={session}
                takeoverCommand={
                  findItemForSession(session, items)?.takeoverCommand
                }
              />
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
