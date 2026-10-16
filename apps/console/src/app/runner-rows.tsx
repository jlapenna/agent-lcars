import { Anchor } from '@mantine/core';

import type {
  FleetHost,
  FleetRunner,
  FleetRunnerState,
} from '../lib/autoscaler-status';
import { isRunnerOnline } from '../lib/runner-status-contract';
import { StateMark, UNAVAILABLE } from './ops-primitives';
import { RelativeTime } from './relative-time';

const STATE_MARK: Record<
  FleetRunnerState,
  { tone: 'ok' | 'fail' | 'warn' | 'busy' | 'idle' | 'neutral'; label: string }
> = {
  starting: { tone: 'neutral', label: 'Starting' },
  idle: { tone: 'idle', label: 'Idle' },
  busy: { tone: 'busy', label: 'Busy' },
  online: { tone: 'ok', label: 'Online' },
  draining: { tone: 'warn', label: 'Draining' },
  offline: { tone: 'fail', label: 'Offline' },
};

const GIB = 1024 ** 3;

/** The mockup's `6c/18G`: cores and GiB, a fraction only below one. */
export function formatRunnerRequest(runner: FleetRunner): string {
  if (runner.requestedCpuMillis === 0 && runner.requestedMemoryBytes === 0)
    return UNAVAILABLE;
  const unit = (value: number) =>
    value >= 1 ? String(Math.round(value)) : value.toFixed(1);
  return `${unit(runner.requestedCpuMillis / 1000)}c/${unit(runner.requestedMemoryBytes / GIB)}G`;
}

/** Runners that are up: everything but starting and offline pods. */
export function onlineRunnerCount(runners: readonly FleetRunner[]): number {
  return runners.filter((runner) => isRunnerOnline(runner.state)).length;
}

/**
 * The panel's fit claim, checked rather than asserted: every runner's request
 * fits on one ready host's allocatable, which Kubernetes already reports net
 * of system and kubelet reserves. Undefined without ready hosts to check.
 */
export function runnerFitMeta(
  runners: readonly FleetRunner[],
  hosts: readonly FleetHost[] | undefined,
): string | undefined {
  const ready = (hosts ?? []).filter((host) => host.ready);
  if (ready.length === 0) return undefined;
  const oversized = runners.filter(
    (runner) =>
      !ready.some(
        (host) =>
          host.cpuMillis >= runner.requestedCpuMillis &&
          host.memoryBytes >= runner.requestedMemoryBytes,
      ),
  ).length;
  return oversized === 0
    ? 'every job fits one host after reserves'
    : `${oversized} ${oversized === 1 ? 'job exceeds' : 'jobs exceed'} every host after reserves`;
}

function RunnerJob({ runner }: { runner: FleetRunner }) {
  if (runner.work) {
    return (
      <Anchor href={runner.work.href} className="ops-ref">
        {runner.work.label}
      </Anchor>
    );
  }
  if (runner.runId) return <>run {runner.runId.slice(0, 8)}</>;
  if (runner.jobRepository) {
    const repoName = runner.jobRepository.split('/').pop();
    const label = runner.jobName ? `${repoName} · ${runner.jobName}` : repoName;
    return runner.workflowRunId ? (
      <Anchor
        href={`https://github.com/${runner.jobRepository}/actions/runs/${runner.workflowRunId}`}
        target="_blank"
        rel="noreferrer"
        className="ops-ref"
      >
        {label} ↗
      </Anchor>
    ) : (
      <>{label}</>
    );
  }
  if (runner.state === 'offline') return <>node NotReady</>;
  return <>{UNAVAILABLE}</>;
}

/** One row per runner pod (design/fleet-console.html#shuttlebay Runners). */
/** An ARC runner's name less the lane prefix its second line already names:
 * "homelab-ci-zh2lg-runner-bnwc8" reads "zh2lg-runner-bnwc8" above
 * "homelab-ci · picard", so the identifying suffix fits one line. */
export function runnerDisplayName(runner: FleetRunner): string {
  const prefix = `${runner.lane}-`;
  return runner.kind !== 'direct' &&
    runner.lane &&
    runner.name.length > prefix.length &&
    runner.name.startsWith(prefix)
    ? runner.name.slice(prefix.length)
    : runner.name;
}

export function RunnerRow({ runner }: { runner: FleetRunner }) {
  const state = STATE_MARK[runner.state];
  return (
    <tr data-testid={`runner-${runner.name}`}>
      <td>
        <span className="ops-host" title={runner.name}>
          {runnerDisplayName(runner)}
        </span>
        <span className="ops-host-spec">
          {runner.kind === 'direct' ? 'direct executor' : runner.lane} ·{' '}
          {runner.host ?? 'unscheduled'}
        </span>
      </td>
      <td>
        <StateMark tone={state.tone}>{state.label}</StateMark>
      </td>
      <td className="ops-mono-dim">
        <RunnerJob runner={runner} />
      </td>
      <td className="ops-num">{formatRunnerRequest(runner)}</td>
      <td className="ops-num ops-dim" title="Since the runner pod started">
        <RelativeTime iso={runner.since} variant="compact" />
      </td>
    </tr>
  );
}
