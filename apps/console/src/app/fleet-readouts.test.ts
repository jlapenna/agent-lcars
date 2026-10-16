import { describe, expect, it, vi } from 'vitest';

import { fleetReadoutWarnings, SPEND_READ_FAILED } from './fleet-readouts';

vi.mock('../lib/autoscaler-status', () => ({}));
vi.mock('../lib/dashboard-data', () => ({}));
vi.mock('../lib/session-archive', () => ({}));

describe('fleetReadoutWarnings', () => {
  it('says nothing when every read reported', () => {
    expect(
      fleetReadoutWarnings({
        activity: { warnings: [] },
        autoscaler: { warnings: [] },
        spendArchive: {},
      }),
    ).toEqual([]);
  });

  it('carries activity and autoscaler problems and a failed spend read', () => {
    expect(
      fleetReadoutWarnings({
        activity: { warnings: ['Activity stale'] },
        autoscaler: { warnings: ['Runner lane stale'] },
        spendArchive: undefined,
      }),
    ).toEqual(['Activity stale', 'Runner lane stale', SPEND_READ_FAILED]);
  });
});
