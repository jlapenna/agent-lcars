import { describe, expect, it } from 'vitest';

import { type BridgeReadoutInput, bridgeReadouts } from './bridge-readouts';

const healthy: BridgeReadoutInput = {
  liveRuns: [
    { pipeline: 'claude' },
    { pipeline: 'claude' },
    { pipeline: 'codex' },
  ],
  liveRunsAvailable: true,
  activeCliSessions: 2,
  cliSessionsAvailable: true,
  cliSessionsTruncated: false,
  stopped: { count: 4, hasMore: false },
  waitingOnDeploy: 1,
  blocked: 2,
};

const byId = (input: BridgeReadoutInput) =>
  Object.fromEntries(bridgeReadouts(input).map((r) => [r.id, r]));

describe('bridgeReadouts', () => {
  it('reports exact figures from healthy reads', () => {
    const readouts = byId(healthy);
    expect(readouts['running']).toMatchObject({
      value: 3,
      detail: 'claude 2 · codex 1',
    });
    expect(readouts['cli']?.value).toBe('2');
    expect(readouts['stopped']?.value).toBe('4');
    expect(readouts['waiting']).toMatchObject({
      value: 3,
      detail: 'deploy 1 · blocked 2',
    });
  });

  it('never turns a failed live-run read into zero agents running', () => {
    const readouts = byId({
      ...healthy,
      liveRuns: [],
      liveRunsAvailable: false,
    });
    expect(readouts['running']).toMatchObject({
      value: '—',
      detail: 'unavailable',
    });
  });

  it('shows unavailable CLI telemetry and a capped list as such', () => {
    expect(
      byId({ ...healthy, activeCliSessions: 0, cliSessionsAvailable: false })[
        'cli'
      ],
    ).toMatchObject({ value: '—', detail: 'unavailable' });
    expect(
      byId({ ...healthy, activeCliSessions: 20, cliSessionsTruncated: true })[
        'cli'
      ]?.value,
    ).toBe('20+');
  });

  it('marks a further stopped-work page and a failed stopped-work read', () => {
    expect(
      byId({ ...healthy, stopped: { count: 200, hasMore: true } })['stopped']
        ?.value,
    ).toBe('200+');
    expect(
      byId({ ...healthy, stopped: { count: 0, hasMore: false, error: 'x' } })[
        'stopped'
      ],
    ).toMatchObject({ value: '—', detail: 'unavailable' });
  });
});
