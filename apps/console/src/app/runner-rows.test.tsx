import { describe, expect, it } from 'vitest';

import type { FleetHost, FleetRunner } from '../lib/autoscaler-status';
import {
  formatRunnerRequest,
  onlineRunnerCount,
  runnerDisplayName,
  runnerFitMeta,
} from './runner-rows';

const GIB = 1024 ** 3;

function runner(overrides: Partial<FleetRunner> = {}): FleetRunner {
  return {
    name: 'r1',
    kind: 'arc',
    lane: 'lcars-ci',
    host: 'spark',
    state: 'busy',
    since: '2026-10-14T07:00:00Z',
    requestedCpuMillis: 6_000,
    requestedMemoryBytes: 18 * GIB,
    ...overrides,
  };
}

function host(overrides: Partial<FleetHost> = {}): FleetHost {
  return {
    name: 'spark',
    ready: true,
    unschedulable: false,
    cpuMillis: 8_000,
    memoryBytes: 32 * GIB,
    requestedCpuMillis: 0,
    requestedMemoryBytes: 0,
    runnerPods: 0,
    queueJobPods: 0,
    ...overrides,
  };
}

describe('Runners panel rows', () => {
  it("writes a request as the mockup's cores and GiB", () => {
    expect(formatRunnerRequest(runner())).toBe('6c/18G');
    expect(
      formatRunnerRequest(
        runner({ requestedCpuMillis: 500, requestedMemoryBytes: GIB / 2 }),
      ),
    ).toBe('0.5c/0.5G');
    expect(
      formatRunnerRequest(
        runner({ requestedCpuMillis: 0, requestedMemoryBytes: 0 }),
      ),
    ).toBe('—');
  });

  it('drops the lane prefix the second line already names', () => {
    expect(
      runnerDisplayName(
        runner({ name: 'homelab-ci-zh2lg-runner-bnwc8', lane: 'homelab-ci' }),
      ),
    ).toBe('zh2lg-runner-bnwc8');
    // Only a whole lane prefix, never the whole name, and never the executor.
    expect(
      runnerDisplayName(runner({ name: 'homelab-cix-r1', lane: 'homelab-ci' })),
    ).toBe('homelab-cix-r1');
    expect(
      runnerDisplayName(runner({ name: 'homelab-ci-', lane: 'homelab-ci' })),
    ).toBe('homelab-ci-');
    expect(
      runnerDisplayName(
        runner({ name: 'queue-executor-1', kind: 'direct', lane: 'queue' }),
      ),
    ).toBe('queue-executor-1');
  });

  it('counts every runner but starting and offline ones as online', () => {
    expect(
      onlineRunnerCount([
        runner({ state: 'busy' }),
        runner({ state: 'idle' }),
        runner({ state: 'online' }),
        runner({ state: 'draining' }),
        runner({ state: 'starting' }),
        runner({ state: 'offline' }),
      ]),
    ).toBe(4);
  });

  it('checks the fit claim against one ready host at a time', () => {
    expect(runnerFitMeta([runner()], [host()])).toBe(
      'every job fits one host after reserves',
    );
    // Two hosts together would fit it; no single one does.
    expect(
      runnerFitMeta(
        [runner({ requestedCpuMillis: 12_000, requestedMemoryBytes: 8 * GIB })],
        [
          host(),
          host({ name: 'picard', cpuMillis: 16_000, memoryBytes: 4 * GIB }),
        ],
      ),
    ).toBe('1 job exceeds every host after reserves');
    // A NotReady host proves nothing.
    expect(runnerFitMeta([runner()], [host({ ready: false })])).toBeUndefined();
  });
});
