import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import { Stack } from '@mantine/core';

import type { AgentPipeline, AgentRun } from '../../lib/agent-activity';
import { FinishedRunRow } from '../agent-activity-panel';
import { Eyebrow } from '../eyebrow';
import { MobileHistoryDisclosure } from '../mobile-history-disclosure';
import { AgentOperationsPanel } from './agent-operations-panel';

const PIPELINES: AgentPipeline[] = ['claude', 'codex', 'opencode'];
const MOBILE_INITIAL_OUTCOME_COUNT = 5;

/**
 * Recent conclusions grouped per pipeline - the same merged recent-runs
 * list the home page collapses behind "Recently finished", just always
 * visible here and split by pipeline: this page cares about the fleet's
 * per-pipeline outcomes, not a single maintainer queue.
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

  const initiallyVisibleRunIds = new Set(
    recentRuns.slice(0, MOBILE_INITIAL_OUTCOME_COUNT).map((run) => run.id),
  );
  const hiddenCount = Math.max(
    0,
    recentRuns.length - MOBILE_INITIAL_OUTCOME_COUNT,
  );

  return (
    <AgentOperationsPanel
      title="Recent Outcomes"
      className="agents-panel--recent"
      testId="recent-outcomes"
    >
      <MobileHistoryDisclosure
        hiddenCount={hiddenCount}
        itemLabel="outcome"
        gap="sm"
        testId="recent-outcomes-disclosure"
      >
        {PIPELINES.map((pipeline) => {
          const runs = recentRuns.filter((run) => run.pipeline === pipeline);
          if (runs.length === 0) return null;
          const groupStartsHidden = runs.every(
            (run) => !initiallyVisibleRunIds.has(run.id),
          );
          return (
            <Stack
              key={pipeline}
              gap={6}
              data-mobile-history-extra={groupStartsHidden || undefined}
            >
              <Eyebrow>
                {pipeline} ({runs.length})
              </Eyebrow>
              <Stack gap={6}>
                {runs.map((run) => (
                  <div
                    key={run.id}
                    data-mobile-history-extra={
                      !initiallyVisibleRunIds.has(run.id) || undefined
                    }
                  >
                    <FinishedRunRow
                      run={run}
                      session={sessionsByRunId[run.id]}
                    />
                  </div>
                ))}
              </Stack>
            </Stack>
          );
        })}
      </MobileHistoryDisclosure>
    </AgentOperationsPanel>
  );
}
