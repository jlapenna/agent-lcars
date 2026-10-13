import type { ReactNode } from 'react';

import type {
  ArcLaneStatus,
  QueueExecutorStatus,
} from '../lib/autoscaler-status';
import { fleetCapacity } from '../lib/runner-status-contract';
import { OpsPanel, StateMark, UNAVAILABLE } from './ops-primitives';

/** Squares drawn per lane; a larger lane is still described in full by its
 * label. */
const SLOT_LIMIT = 24;

function Slots({
  busy,
  idle,
  pending,
  max,
}: {
  busy: number;
  idle: number;
  pending: number;
  max?: number;
}) {
  const squares: Array<'busy' | 'idle' | 'pending' | 'free'> = [
    ...Array<'busy'>(busy).fill('busy'),
    ...Array<'idle'>(idle).fill('idle'),
    ...Array<'pending'>(pending).fill('pending'),
  ];
  if (max !== undefined) {
    while (squares.length < Math.min(max, SLOT_LIMIT)) squares.push('free');
  }
  return (
    <div
      className="ops-slots"
      aria-label={`${busy} busy, ${idle} idle, ${pending} pending${max !== undefined ? ` of ${max}` : ''}`}
    >
      {squares.slice(0, SLOT_LIMIT).map((state, i) => (
        <i key={i} data-state={state} />
      ))}
    </div>
  );
}

export function RunnerFleetPanel({
  lanes,
  lanesIncomplete,
  executor,
  chip,
}: {
  lanes?: ArcLaneStatus[];
  lanesIncomplete?: boolean;
  executor?: QueueExecutorStatus;
  /** The fleet chip: the authoritative one-line fleet summary. */
  chip?: ReactNode;
}) {
  // No lane records is unknown capacity, not zero capacity.
  const known = lanes !== undefined && lanes.length > 0 && !lanesIncomplete;
  const online = lanes?.reduce((n, lane) => n + lane.registeredRunners, 0);
  const max = lanes && fleetCapacity(lanes);
  return (
    <OpsPanel
      title="Runner fleet"
      count={
        known
          ? max === undefined
            ? `${online}`
            : `${online}/${max}`
          : UNAVAILABLE
      }
      meta={chip}
      data-testid="runner-fleet-panel"
    >
      <table className="ops-table">
        <thead>
          <tr>
            <th>Host</th>
            <th>Slots</th>
            <th>Load</th>
          </tr>
        </thead>
        <tbody>
          {(lanes ?? []).map((lane) => (
            <tr key={lane.lane} data-testid={`fleet-lane-${lane.lane}`}>
              <td>
                <span className="ops-host">{lane.lane}</span>
                <span className="ops-host-spec">
                  ARC lane · {lane.registeredRunners} registered ·{' '}
                  {lane.maxRunners === undefined
                    ? 'no max'
                    : `max ${lane.maxRunners}`}
                </span>
              </td>
              <td>
                <Slots
                  busy={lane.runningJobs}
                  idle={lane.idleRunners}
                  pending={lane.pendingJobs}
                  max={lane.maxRunners}
                />
              </td>
              <td className="ops-dim">
                {UNAVAILABLE}{' '}
                <span className="ops-unavailable">host load unavailable</span>
              </td>
            </tr>
          ))}
          {executor && (
            <tr data-testid="fleet-direct-executor">
              <td>
                <span className="ops-host">direct executor</span>
                <span className="ops-host-spec">
                  QueueExecutor · limit {executor.maxConcurrent}
                </span>
              </td>
              <td>
                {executor.activeRuns === undefined ? (
                  <span className="ops-dim">active unknown</span>
                ) : (
                  <Slots
                    busy={executor.activeRuns}
                    idle={0}
                    pending={0}
                    max={executor.maxConcurrent}
                  />
                )}
              </td>
              <td>
                <StateMark
                  tone={
                    !executor.ready ? 'fail' : executor.draining ? 'warn' : 'ok'
                  }
                >
                  {!executor.ready
                    ? 'Not ready'
                    : executor.draining
                      ? 'Draining'
                      : 'Ready'}
                </StateMark>
              </td>
            </tr>
          )}
          {(lanes === undefined || lanes.length === 0) && !executor && (
            <tr>
              <td colSpan={3} className="ops-dim">
                Runner status unavailable
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="ops-telemetry" data-testid="fleet-telemetry">
        {['Tokens / min', 'CI wait p50', 'Work API p95'].map((label) => (
          <div key={label}>
            <div className="lcars-eyebrow">{label}</div>
            <div className="ops-telemetry__value">{UNAVAILABLE}</div>
            <div className="ops-unavailable">no metrics source</div>
          </div>
        ))}
      </div>
    </OpsPanel>
  );
}
