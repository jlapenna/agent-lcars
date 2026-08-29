import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import { Stack, Text } from '@mantine/core';

import type { ActionItem } from '../../lib/action-items';
import type { AgentRun } from '../../lib/agent-activity';
import { findItemForSession } from '../../lib/claimed-idle';
import type { CliSession } from '../../lib/cli-sessions';
import {
  CliSessionRow,
  LiveRunGroupList,
  type RunItemRef,
} from '../agent-activity-panel';
import { AgentOperationsPanel } from './agent-operations-panel';

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
  itemsByRunId: Record<string, RunItemRef>;
  activeSessions: CliSession[];
  items: ActionItem[];
  /** Joined `issue-agent` session docs, keyed by `AgentRun.id` - see
   * `indexSessionsByRunId` in run-classification.ts. */
  sessionsByRunId?: Record<string, IssueAgentSessionDoc>;
}) {
  const hasActivity = liveRuns.length > 0 || activeSessions.length > 0;

  return (
    <AgentOperationsPanel
      title="Active Agents"
      className="agents-panel--active"
      testId="active-agents-section"
      separated
    >
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
    </AgentOperationsPanel>
  );
}
