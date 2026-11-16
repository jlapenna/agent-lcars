import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import { Anchor, Group, Text } from '@mantine/core';
import type { ReactNode } from 'react';

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
  merged,
  olderHref,
  newestHref,
}: {
  recentRuns: AgentRun[];
  /** The mockup's "N merged · 24h" head (see merged-last-day.tsx). */
  merged?: ReactNode;
  /** Joined `issue-agent` session docs, keyed by `AgentRun.id` - see
   * `indexSessionsByRunId` in run-classification.ts. */
  sessionsByRunId?: Record<string, IssueAgentSessionDoc>;
  /** The next page of the outcome history, when more runs exist. */
  olderHref?: string;
  /** Back to the newest outcomes; set while paging the history. */
  newestHref?: string;
}) {
  // Recent outcomes are useful evidence only when there is evidence to
  // inspect. Suppressing the empty panel keeps the first viewport focused on
  // activity and exceptions, without hiding any actionable state. A page of
  // the history, or an empty newest page with older history behind it,
  // always renders, so its navigation stays reachable.
  if (
    recentRuns.length === 0 &&
    newestHref === undefined &&
    olderHref === undefined
  )
    return null;

  const pager =
    olderHref || newestHref ? (
      <Group gap="md" data-testid="outcome-history-pager">
        {newestHref && (
          <Anchor href={newestHref} size="sm" className="operations-more-link">
            ← Newest outcomes
          </Anchor>
        )}
        {olderHref && (
          <Anchor href={olderHref} size="sm" className="operations-more-link">
            Older outcomes →
          </Anchor>
        )}
      </Group>
    ) : undefined;

  return (
    <RecentCompletionsPanel
      runs={recentRuns}
      sessionsByRunId={sessionsByRunId}
      testId="recent-outcomes"
      title={newestHref ? 'Earlier completions' : undefined}
      merged={merged}
      mobileInitialCount={MOBILE_INITIAL_OUTCOME_COUNT}
      footer={
        <>
          {recentRuns.length === 0 && (
            <Text size="sm" c="dimmed">
              {newestHref
                ? 'No matching outcomes on this page of the history.'
                : 'No matching outcomes among the newest runs.'}
            </Text>
          )}
          {pager}
        </>
      }
    />
  );
}
