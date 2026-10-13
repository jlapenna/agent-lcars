import type { ReactNode } from 'react';

import type {
  ArcLaneStatus,
  QueueExecutorStatus,
} from '../lib/autoscaler-status';
import { CI_WAIT_MINUTES, fleetCiWait } from '../lib/ci-wait';
import { fleetCapacity } from '../lib/runner-status-contract';
import { formatDuration } from './format';
import { OpsPanel, Sparkline, StateMark, UNAVAILABLE } from './ops-primitives';

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
  filteredOut = false,
}: {
  lanes?: ArcLaneStatus[];
  lanesIncomplete?: boolean;
  executor?: QueueExecutorStatus;
  /** The fleet chip: the authoritative one-line fleet summary. */
  chip?: ReactNode;
  /** A page filter, not missing data, left no lane to show. */
  filteredOut?: boolean;
}) {
  // No lane records is unknown capacity, not zero capacity - unless a filter
  // emptied a known fleet.
  const known =
    filteredOut ||
    (lanes !== undefined && lanes.length > 0 && !lanesIncomplete);
  const online = lanes?.reduce((n, lane) => n + lane.registeredRunners, 0);
  const max = lanes && fleetCapacity(lanes);
  const ciWait = lanes && fleetCiWait(lanes);
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
                {filteredOut
                  ? 'No runner lane matches these filters.'
                  : 'Runner status unavailable'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="ops-telemetry" data-testid="fleet-telemetry">
        <UnavailableTelemetry label="Tokens / min" />
        <div data-testid="fleet-ci-wait">
          <div className="lcars-eyebrow">CI wait p50</div>
          {ciWait === undefined ? (
            <>
              <div className="ops-telemetry__value">{UNAVAILABLE}</div>
              <div className="ops-unavailable">no job-startup data</div>
            </>
          ) : (
            <>
              <div className="ops-telemetry__value">
                {ciWait.p50Seconds === undefined
                  ? UNAVAILABLE
                  : formatWait(ciWait.p50Seconds)}
              </div>
              <div className="ops-telemetry__detail">
                {ciWait.jobs === 0
                  ? `no job started · ${CI_WAIT_MINUTES}m`
                  : `${ciWait.jobs} ${ciWait.jobs === 1 ? 'job' : 'jobs'} · ${CI_WAIT_MINUTES}m`}
                {(ciWait.partial || lanesIncomplete) && ' · partial'}
              </div>
              <Sparkline
                values={ciWait.series}
                label={`CI queue wait p50 per minute, last ${CI_WAIT_MINUTES} minutes`}
              />
            </>
          )}
        </div>
        <UnavailableTelemetry label="Work API p95" />
      </div>
    </OpsPanel>
  );
}

/** ARC's smallest startup buckets are fractions of a second; "0s" would read
 * as no wait at all. */
function formatWait(seconds: number): string {
  return seconds < 1 ? '<1s' : formatDuration(seconds);
}

function UnavailableTelemetry({ label }: { label: string }) {
  return (
    <div>
      <div className="lcars-eyebrow">{label}</div>
      <div className="ops-telemetry__value">{UNAVAILABLE}</div>
      <div className="ops-unavailable">no metrics source</div>
    </div>
  );
}
