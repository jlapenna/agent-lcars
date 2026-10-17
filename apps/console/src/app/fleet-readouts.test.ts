import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAutoscalerStatuses } from '../lib/autoscaler-status';
import { getCliSessions } from '../lib/cli-sessions';
import { getCachedAgentActivity } from '../lib/dashboard-data';
import { getSessionArchive } from '../lib/session-archive';
import {
  fleetReadoutWarnings,
  loadFleetReadouts,
  SPEND_READ_FAILED,
} from './fleet-readouts';

vi.mock('../lib/autoscaler-status', () => ({ getAutoscalerStatuses: vi.fn() }));
vi.mock('../lib/cli-sessions', () => ({ getCliSessions: vi.fn() }));
vi.mock('../lib/dashboard-data', () => ({ getCachedAgentActivity: vi.fn() }));
vi.mock('../lib/session-archive', () => ({
  getSessionArchive: vi.fn(),
  parseSessionArchiveQuery: vi.fn(),
}));

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

describe('loadFleetReadouts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getCachedAgentActivity).mockResolvedValue({
      data: {
        liveRuns: [],
        recentRuns: [],
        queue: { queued: 0, claimed: 0, running: 0 },
        warnings: [],
      },
      fetchedAt: new Date().toISOString(),
    });
    vi.mocked(getAutoscalerStatuses).mockResolvedValue({ warnings: [] });
    vi.mocked(getSessionArchive).mockResolvedValue(
      {} as Awaited<ReturnType<typeof getSessionArchive>>,
    );
  });

  it('includes local agents in the shared readouts and respects repository scope', async () => {
    vi.mocked(getCliSessions).mockResolvedValue({
      sessions: [
        {
          sessionId: 'local-a',
          agent: 'codex',
          liveness: 'live',
          repo: { owner: 'a', name: 'repo' },
        },
        {
          sessionId: 'local-b',
          agent: 'claude-code',
          liveness: 'idle',
          repo: { owner: 'b', name: 'repo' },
        },
        { sessionId: 'legacy', agent: 'codex', liveness: 'live' },
      ] as Awaited<ReturnType<typeof getCliSessions>>['sessions'],
      warnings: [],
    });
    expect(
      (await loadFleetReadouts()).readouts.find((r) => r.id === 'running')
        ?.value,
    ).toBe(3);
    expect(
      (await loadFleetReadouts('a/repo')).readouts.find(
        (r) => r.id === 'running',
      )?.value,
    ).toBe(1);
    expect(getCliSessions).toHaveBeenCalledWith({ exhaustive: true });
  });

  it('surfaces incomplete telemetry rather than an exact dispatched-only count', async () => {
    vi.mocked(getCliSessions).mockResolvedValue({
      sessions: [],
      warnings: ['CLI sessions unavailable'],
    });
    const result = await loadFleetReadouts();
    expect(result.readouts.find((r) => r.id === 'running')?.value).toBe('—');
    expect(result.warnings).toContain('CLI sessions unavailable');
  });
});
