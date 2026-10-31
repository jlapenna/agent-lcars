import { STORED_PIPELINES } from '@agent-lcars/work';
import { VisuallyHidden } from '@mantine/core';
import type { ReactNode } from 'react';

import type { AgentActivity } from '../../lib/agent-activity';
import type { ActivityMetrics } from '../../lib/logical-work';
import { FleetChip, QueueHealthAlert } from '../agent-activity-panel';
import { FleetRunnerOccupancy } from '../fleet-status';

/**
 * #306's capacity-vs-work distinction: the raw queued and running attempts,
 * under the logical-task figure they must never be read as a substitute for
 * (see `deriveActivityMetrics`'s own doc comment).
 */
function MetricsRow({ metrics }: { metrics: ActivityMetrics }) {
  const hasDispatchWork =
    metrics.logicalTaskCount > 0 ||
    metrics.queuedRuns > 0 ||
    metrics.runningRuns > 0;

  if (!hasDispatchWork) {
    return (
      <span data-testid="activity-metrics-row">
        No queued or running dispatches
      </span>
    );
  }

  return (
    <span data-testid="activity-metrics-row">
      <span data-testid="metric-queued-attempts">
        {metrics.queuedRuns} queued run{metrics.queuedRuns === 1 ? '' : 's'}
      </span>
      {' · '}
      <span data-testid="metric-running-attempts">
        {metrics.runningRuns} running run{metrics.runningRuns === 1 ? '' : 's'}
      </span>
    </span>
  );
}

/**
 * The /agents page's opening readout row, in the Bridge's readout cells
 * (design/fleet-console.html): live runs by pipeline, active CLI sessions,
 * runner occupancy with the producers' own status line, the queue, and
 * #306's logical tasks beside the raw attempts. The queue-stall alert the
 * Bridge's In Flight panel shows follows it, reused verbatim.
 */
export function FleetSnapshotBar({
  activity,
  activeCliSessionCount,
  metrics,
}: {
  activity: AgentActivity;
  activeCliSessionCount: number;
  metrics?: ActivityMetrics;
}) {
  const { liveRuns, fleet, queue } = activity;
  const livePipelines = STORED_PIPELINES.map((pipeline) => ({
    pipeline,
    count: liveRuns.filter((run) => run.pipeline === pipeline).length,
  })).filter(({ count }) => count > 0);

  return (
    <div data-testid="fleet-snapshot-bar" className="agents-fleet-strip">
      <section className="lcars-readouts" aria-label="Fleet snapshot">
        <Readout label="Live runs" value={liveRuns.length}>
          {livePipelines.length > 0
            ? livePipelines
                .map(({ pipeline, count }) => `${pipeline} ${count}`)
                .join(' · ')
            : 'No runs active'}
        </Readout>
        <Readout label="CLI sessions" value={activeCliSessionCount}>
          active
        </Readout>
        <Readout
          label="Runners busy"
          value={<FleetRunnerOccupancy fleet={fleet} />}
        >
          <FleetChip fleet={fleet} />
        </Readout>
        <Readout label="Queue" value={queue ? queue.queued : '—'}>
          {queue ? (
            <span data-testid="queue-lifecycle">
              {queue.queued} queued · {queue.claimed} claimed · {queue.running}{' '}
              running
            </span>
          ) : (
            'unavailable'
          )}
        </Readout>
        {metrics && (
          <Readout
            label="Logical tasks"
            value={
              <span data-testid="metric-logical-tasks">
                {metrics.logicalTaskCount}
                <VisuallyHidden>
                  {' '}
                  logical task{metrics.logicalTaskCount === 1 ? '' : 's'}
                </VisuallyHidden>
              </span>
            }
          >
            <MetricsRow metrics={metrics} />
          </Readout>
        )}
      </section>
      <QueueHealthAlert liveRuns={liveRuns} />
    </div>
  );
}

function Readout({
  label,
  value,
  children,
}: {
  label: string;
  value: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="lcars-readout">
      <span className="lcars-eyebrow lcars-readout__label">{label}</span>
      <span className="lcars-readout__value">{value}</span>
      <div className="lcars-readout__detail">{children}</div>
    </div>
  );
}
