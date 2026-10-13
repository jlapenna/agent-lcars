import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';

import type { ActionItem } from '../../lib/action-items';
import type { AgentRun } from '../../lib/agent-activity';
import type { CliSession } from '../../lib/cli-sessions';
import type { RunItemRef } from '../agent-activity-panel';
import { ActiveDispatchesPanel, CliSessionsPanel } from '../ops-panels';

/**
 * Every actor currently working something (design/fleet-console.html
 * #agents): the active dispatches table with its Runner column, then the
 * interactive CLI sessions in the same panel language.
 */
export function ActiveAgentsSection({
  liveRuns,
  itemsByRunId,
  activeSessions,
  items: _items,
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
  return (
    <div className="agents-active" data-testid="active-agents-section">
      <ActiveDispatchesPanel
        liveRuns={liveRuns}
        itemsByRunId={itemsByRunId}
        sessionsByRunId={sessionsByRunId}
        showRunner
        // The fleet snapshot bar above already carries the alert.
        showQueueHealth={false}
        testId="active-dispatches"
      />
      {activeSessions.length > 0 && (
        <CliSessionsPanel sessions={activeSessions} />
      )}
    </div>
  );
}
