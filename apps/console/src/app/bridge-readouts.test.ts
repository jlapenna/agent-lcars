import { describe, expect, it } from 'vitest';

import type { RunTimeline } from '../lib/run-history';
import {
  type BridgeReadoutInput,
  bridgeReadouts,
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
