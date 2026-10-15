import { describe, expect, it } from 'vitest';

import type { RunTimeline } from '../lib/run-history';
import {
  type BridgeReadoutInput,
  bridgeReadouts,
  dayOfHours,
  fleetReadoutInput,
} from './bridge-readouts';

const healthy: BridgeReadoutInput = {
  fleet: { online: 11, busy: 7, capacity: 12 },
  liveRuns: [
    { pipeline: 'claude', status: 'running', elapsedSeconds: 600 },
    { pipeline: 'claude', status: 'running', elapsedSeconds: 60 },
    { pipeline: 'codex', status: 'running', elapsedSeconds: 60 },
    { pipeline: 'codex', status: 'queued', elapsedSeconds: 1_080 },
  ],
  liveRunsAvailable: true,
  queue: { queued: 1, claimed: 2, running: 3 },
  spendToday: { costUsd: 38.42, estimated: false, partial: false },
};

const byId = (input: BridgeReadoutInput) =>
  Object.fromEntries(bridgeReadouts(input).map((r) => [r.id, r]));

describe('bridgeReadouts', () => {
  it('divides busy runners by the lanes, not by pods from the inventory', () => {
    // Pods online (3) can disagree with the lanes' registered runners (5),
    // e.g. pods on a NotReady host; running jobs are a lane measure.
    const r = byId({
      ...healthy,
      fleet: { online: 3, registered: 5, busy: 4, capacity: 3 },
    });
    expect(r['online']?.value).toBe('3 / 3');
    expect(r['busy']).toMatchObject({
      value: '4 / 5',
      detail: '80% utilisation · 1 idle',
    });
  });

  it('reports the mockup readouts from healthy reads', () => {
    const r = byId(healthy);
    expect(r['online']?.value).toBe('11 / 12');
    expect(r['busy']).toMatchObject({
      value: '7 / 11',
      detail: '64% utilisation · 4 idle',
    });
    expect(r['queue']).toMatchObject({ value: 3 });
    expect(r['queue']?.detail).toContain('2 claimed · oldest');
    expect(r['running']).toMatchObject({
      value: 3,
      detail: 'claude 2 · codex 1',
    });
    // The cost budget is window-scoped, so today is never shown as a share.
    expect(r['spend']?.detail).toBe('since 00:00 UTC · no daily budget');
  });

  it('marks a spend total the archive limit truncated as a lower bound', () => {
    const r = byId({
      ...healthy,
      spendToday: { costUsd: 38.42, estimated: false, partial: true },
    });
    expect(r['spend']).toMatchObject({
      value: '$38.42+',
      detail: 'partial: session archive limit reached',
    });
  });

  it('never turns failed reads into zeros', () => {
    const r = byId({
      fleet: {},
      liveRuns: [],
      liveRunsAvailable: false,
    });
    for (const id of ['online', 'busy', 'queue', 'running', 'spend']) {
      expect(r[id]?.value).toBe('—');
    }
  });

  it('draws queue and running sparklines from the history, others unavailable', () => {
    const r = byId({
      ...healthy,
      history: { queued: [0, 2, 3], running: [1, 3, 3] },
    });
    expect(r['queue']?.spark).toEqual({
      label: 'Queue depth, last 30 minutes',
      values: [0, 2, 3],
    });
    expect(r['running']?.spark?.values).toEqual([1, 3, 3]);
    for (const id of ['online', 'busy', 'spend']) {
      expect(r[id]?.spark?.values).toBeUndefined();
    }
    expect(byId(healthy)['queue']?.spark?.values).toBeUndefined();
  });

  it('draws runner and hourly spend sparklines when their sources report', () => {
    const r = byId({
      ...healthy,
      runnerHistory: { online: [12, undefined, 11], busy: [6, undefined, 7] },
      spendToday: {
        costUsd: 3,
        byHourUsd: [1, 0, 2],
        estimated: false,
        partial: true,
      },
    });
    expect(r['online']?.spark?.values).toEqual([12, undefined, 11]);
    expect(r['busy']?.spark?.values).toEqual([6, undefined, 7]);
    expect(r['spend']?.spark).toEqual({
      label: 'Spend per hour today, by last activity (lower bound)',
      // 24 slots ending at the current hour; those before midnight empty.
      values: [...Array.from({ length: 21 }, () => undefined), 1, 0, 2],
    });
  });
});

describe('fleetReadoutInput', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const timeline = (owner: string): RunTimeline => ({
    repo: { owner, name: 'repo' },
    createdAt: new Date(now - 5 * 60_000).toISOString(),
    transitions: [],
    state: 'pending',
    updatedAt: new Date(now - 5 * 60_000).toISOString(),
  });

  it('narrows the run history to the page scope', () => {
    const input = fleetReadoutInput({
      activity: {
        queue: { queued: 2, claimed: 0, running: 0 },
        runHistory: [timeline('a'), timeline('b')],
      },
      liveRuns: [],
      repo: 'a/repo',
      autoscaler: {},
      now,
    });
    expect(input.history?.queued.at(-1)).toBe(1);
    expect(input.history?.queued[0]).toBe(0);
  });

  it('takes fleet runner history from the lanes, and none while one is missing', () => {
    const lane = (
      runnerHistory?: { at: string; registered: number; running: number }[],
    ) =>
      ({
        schemaVersion: 3,
        kind: 'arc-lane',
        lane: 'l',
        registrationUrl: 'https://github.com/o',
        assignedJobs: 0,
        runningJobs: 0,
        pendingJobs: 0,
        idleRunners: 0,
        registeredRunners: 0,
        desiredRunners: 0,
        minRunners: 0,
        updatedAt: new Date(now).toISOString(),
        ...(runnerHistory ? { runnerHistory } : {}),
      }) as const;
    const sample = [
      { at: new Date(now - 5_000).toISOString(), registered: 3, running: 2 },
    ];
    const withHistory = fleetReadoutInput({
      // Pods online (8) differ from the lanes' registered runners (7).
      activity: { fleet: { online: 8, registered: 7, busy: 5 } },
      liveRuns: [],
      autoscaler: { lanes: [lane(sample), lane(sample)] },
      now,
    });
    // The lanes sampled 6/4 a minute ago; the newest bar is their current
    // count, never the pod count from a different measure.
    expect(withHistory.runnerHistory?.online.slice(-2)).toEqual([undefined, 7]);
    expect(withHistory.runnerHistory?.busy.at(-1)).toBe(5);
    expect(
      fleetReadoutInput({
        activity: {},
        liveRuns: [],
        autoscaler: { lanes: [lane(sample), lane()] },
        now,
      }).runnerHistory,
    ).toBeUndefined();
    expect(
      fleetReadoutInput({
        activity: {},
        liveRuns: [],
        autoscaler: { lanes: [lane(sample)], lanesIncomplete: true },
        now,
      }).runnerHistory,
    ).toBeUndefined();
  });

  it('has no history when the live read failed', () => {
    const input = fleetReadoutInput({
      activity: { runHistory: [timeline('a')] },
      liveRuns: [],
      autoscaler: {},
      now,
    });
    expect(input.history).toBeUndefined();
  });
});

describe('dayOfHours', () => {
  it('keeps a day of hourly slots so early hours draw as bars, not a block', () => {
    const values = dayOfHours([1.5]);
    expect(values).toHaveLength(24);
    expect(values?.slice(0, 23).every((v) => v === undefined)).toBe(true);
    expect(values?.at(-1)).toBe(1.5);
    expect(dayOfHours(undefined)).toBeUndefined();
    expect(dayOfHours(Array.from({ length: 24 }, () => 1))).toHaveLength(24);
  });
});
