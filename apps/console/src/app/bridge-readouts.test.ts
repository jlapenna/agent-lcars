import { describe, expect, it } from 'vitest';

import { type BridgeReadoutInput, bridgeReadouts } from './bridge-readouts';

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
  budgetUsd: 60,
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
    expect(r['spend']?.detail).toBe('of $60.00 budget · 64%');
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
});
