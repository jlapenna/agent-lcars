import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';

import type { AgentRun } from '../../lib/agent-activity';
import { RecentCompletionsPanel } from '../ops-panels';

const MOBILE_INITIAL_OUTCOME_COUNT = 5;

/**
 * Recent conclusions across every agent (design/fleet-console.html #agents
 * "Recent completions"), with the agent as a column. Phones show the five
 * newest first, the rest behind a disclosure.
 */
export function RecentOutcomesSection({
  recentRuns,
  sessionsByRunId = {},
}: {
  recentRuns: AgentRun[];
  /** Joined `issue-agent` session docs, keyed by `AgentRun.id` - see
   * `indexSessionsByRunId` in run-classification.ts. */
  sessionsByRunId?: Record<string, IssueAgentSessionDoc>;
}) {
  // Recent outcomes are useful evidence only when there is evidence to
  // inspect. Suppressing the empty panel keeps the first viewport focused on
  // activity and exceptions, without hiding any actionable state.
  if (recentRuns.length === 0) return null;

  return (
    <RecentCompletionsPanel
      runs={recentRuns}
      sessionsByRunId={sessionsByRunId}
      testId="recent-outcomes"
      mobileInitialCount={MOBILE_INITIAL_OUTCOME_COUNT}
    />
  );
}
