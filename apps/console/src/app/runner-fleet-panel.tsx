import type { ReactNode } from 'react';

import type {
  ArcLaneStatus,
  FleetHost,
  FleetHostInventory,
  QueueExecutorStatus,
} from '../lib/autoscaler-status';
import { CI_WAIT_MINUTES, fleetCiWait } from '../lib/ci-wait';
import {
  HISTOGRAM_WINDOW_MINUTES,
  type HistogramWindow,
  summarizeWindows,
} from '../lib/histogram-window';
import { fleetCapacity } from '../lib/runner-status-contract';
import {
  TOKEN_RATE_AVERAGE_MINUTES,
  TOKEN_RATE_MINUTES,
  type TokenRate,
} from '../lib/token-rate';
import { formatDuration } from './format';
import {
  formatTokens,
  Meter,
  OpsPanel,
  Sparkline,
  StateMark,
  UNAVAILABLE,
} from './ops-primitives';

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
  tokenRate,
  workApiLatency,
  hostInventory,
}: {
  lanes?: ArcLaneStatus[];
  lanesIncomplete?: boolean;
  executor?: QueueExecutorStatus;
  /** The fleet chip: the authoritative one-line fleet summary. */
  chip?: ReactNode;
  /** A page filter, not missing data, left no lane to show. */
  filteredOut?: boolean;
  /** Tokens / min, or why it is unknown: the session store failed, or no
   * active session records per-minute tokens. */
  tokenRate?: TokenRate | { unavailable: string };
  /** The queue executor's Work API response times. Passed apart from
   * `executor` because a page filter can hide the executor's row without
   * changing how the Work API is responding. */
  workApiLatency?: HistogramWindow;
  /** One row per cluster node, as the mockup draws the fleet. Without it the
   * rows fall back to ARC lanes, whose host load is unknown. */
  hostInventory?: FleetHostInventory;
}) {
  const hosts = hostInventory?.hosts.length ? hostInventory.hosts : undefined;
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
            <th>{hosts ? 'Load · requested' : 'Load'}</th>
          </tr>
        </thead>
        <tbody>
          {hosts?.map((host) => (
            <HostRow key={host.name} host={host} />
          ))}
          {(hosts ? [] : (lanes ?? [])).map((lane) => (
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
          {!hosts &&
            (lanes === undefined || lanes.length === 0) &&
            !executor && (
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
        <TokenRateTelemetry tokenRate={tokenRate} />
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
                  ? `no job started · ${ciWait.coveredMinutes}m`
                  : `${ciWait.jobs} ${ciWait.jobs === 1 ? 'job' : 'jobs'} · ${ciWait.coveredMinutes}m`}
                {(ciWait.partial || lanesIncomplete) && ' · partial'}
              </div>
              <Sparkline
                values={ciWait.series}
                label={`CI queue wait p50 per minute, last ${CI_WAIT_MINUTES} minutes`}
              />
            </>
          )}
        </div>
        <WorkApiTelemetry window={workApiLatency} />
      </div>
    </OpsPanel>
  );
}

/** ARC's smallest startup buckets are fractions of a second; "0s" would read
 * as no wait at all. */
function formatWait(seconds: number): string {
  return seconds < 1 ? '<1s' : formatDuration(seconds);
}

function TokenRateTelemetry({
  tokenRate,
}: {
  tokenRate?: TokenRate | { unavailable: string };
}) {
  if (!tokenRate || 'unavailable' in tokenRate) {
    return (
      <div data-testid="fleet-token-rate">
        <div className="lcars-eyebrow">Tokens / min</div>
        <div className="ops-telemetry__value">{UNAVAILABLE}</div>
        <div className="ops-unavailable">
          {tokenRate?.unavailable ?? 'no session data'}
        </div>
      </div>
    );
  }
  return (
    <div data-testid="fleet-token-rate">
      <div className="lcars-eyebrow">Tokens / min</div>
      <div className="ops-telemetry__value">
        {formatTokens(tokenRate.perMinute)}
      </div>
      <div className="ops-telemetry__detail">
        {tokenRate.sessions === 0
          ? 'no active session'
          : `${TOKEN_RATE_AVERAGE_MINUTES}m avg · ${tokenRate.sessions} ${tokenRate.sessions === 1 ? 'session' : 'sessions'}`}
        {tokenRate.partial && ' · partial'}
      </div>
      <Sparkline
        values={tokenRate.series}
        label={`Tokens per minute, last ${TOKEN_RATE_MINUTES} minutes`}
      />
    </div>
  );
}

const GIB = 1024 ** 3;

/** Runner and queue Job pods on a host. Whether a warm runner pod has a job
 * is not visible to the executor, so these are pods, never "busy". */
function PodSlots({ runners, jobs }: { runners: number; jobs: number }) {
  const label = `${runners} runner ${runners === 1 ? 'pod' : 'pods'}, ${jobs} queue job ${jobs === 1 ? 'pod' : 'pods'}`;
  return (
    <div className="ops-slots" role="img" aria-label={label} title={label}>
      {Array.from({ length: Math.min(runners + jobs, SLOT_LIMIT) }, (_, i) => (
        <i key={i} data-state="pod" />
      ))}
    </div>
  );
}

function loadTone(fraction: number): 'warn' | 'fail' | undefined {
  return fraction >= 1 ? 'fail' : fraction >= 0.8 ? 'warn' : undefined;
}

function HostRow({ host }: { host: FleetHost }) {
  const cpu = host.cpuMillis > 0 ? host.requestedCpuMillis / host.cpuMillis : 0;
  const memory =
    host.memoryBytes > 0 ? host.requestedMemoryBytes / host.memoryBytes : 0;
  const pods = host.runnerPods + host.queueJobPods;
  return (
    <tr data-testid={`fleet-host-${host.name}`}>
      <td>
        <span className="ops-host">{host.name}</span>
        <span className="ops-host-spec">
          {Math.round(host.cpuMillis / 1000)} vCPU ·{' '}
          {Math.round(host.memoryBytes / GIB)} GiB
          {host.unschedulable && ' · draining'}
        </span>
      </td>
      <td>
        {pods === 0 ? (
          <span className="ops-dim">no runners</span>
        ) : (
          <PodSlots runners={host.runnerPods} jobs={host.queueJobPods} />
        )}
      </td>
      <td>
        {!host.ready ? (
          <StateMark tone="fail">NotReady</StateMark>
        ) : (
          <div className="ops-bars">
            {(
              [
                ['CPU', cpu],
                ['MEM', memory],
              ] as const
            ).map(([label, fraction]) => (
              <div key={label}>
                <span>{label}</span>
                <Meter
                  fraction={fraction}
                  tone={loadTone(fraction)}
                  label={`${label} requested on ${host.name}`}
                />
                <span>{Math.round(fraction * 100)}%</span>
              </div>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}

/** Response times are milliseconds until they are not. */
function formatLatency(seconds: number): string {
  return seconds < 1
    ? `${Math.round(seconds * 1000)} ms`
    : `${seconds.toFixed(1)} s`;
}

function WorkApiTelemetry({ window }: { window?: HistogramWindow }) {
  const latency = window && summarizeWindows([window], 0.95);
  return (
    <div data-testid="fleet-work-api">
      <div className="lcars-eyebrow">Work API p95</div>
      <div className="ops-telemetry__value">
        {latency?.quantile === undefined
          ? UNAVAILABLE
          : formatLatency(latency.quantile)}
      </div>
      {latency === undefined ? (
        <div className="ops-unavailable">no executor latency data</div>
      ) : (
        <>
          <div className="ops-telemetry__detail">
            {latency.count === 0
              ? `no calls · ${latency.coveredMinutes}m`
              : `${latency.count} ${latency.count === 1 ? 'call' : 'calls'} · ${latency.coveredMinutes}m`}
          </div>
          <Sparkline
            values={latency.series}
            label={`Work API p95 latency per minute, last ${HISTOGRAM_WINDOW_MINUTES} minutes`}
          />
        </>
      )}
    </div>
  );
}
