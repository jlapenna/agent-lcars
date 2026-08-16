import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readAuthoritativeTaskState } = vi.hoisted(() => ({
  readAuthoritativeTaskState: vi.fn(),
}));

vi.mock('@/lib/authoritative-task-state', () => ({
  readAuthoritativeTaskState,
}));

import { GET } from './route';

const params = Promise.resolve({
  owner: 'jlapenna',
  repo: 'agent-lcars',
  issue: '824',
});

beforeEach(() => {
  vi.clearAllMocks();
  readAuthoritativeTaskState.mockResolvedValue({
    schema: 'agent-lcars.authoritative-task-state/v2',
    task: { repo: 'jlapenna/agent-lcars', issue: 824 },
    storageRevision: 9,
    updatedAt: '2026-08-09T00:00:00.000Z',
    activeRunId: 'jlapenna/agent-lcars#824/r3',
    runs: [],
  });
});

describe('GET /api/control-plane/task-state/:owner/:repo/:issue', () => {
  it('returns the exact no-store authoritative aggregate', async () => {
    const response = await GET(new Request('https://console.test/task-state'), {
      params,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(readAuthoritativeTaskState).toHaveBeenCalledWith({
      repository: 'jlapenna/agent-lcars',
      issue: 824,
    });
    await expect(response.json()).resolves.toMatchObject({
      storageRevision: 9,
    });
  });

  it('fails closed before storage for another repository', async () => {
    const response = await GET(new Request('https://console.test/task-state'), {
      params: Promise.resolve({
        owner: 'someone',
        repo: 'elsewhere',
        issue: '824',
      }),
    });
    expect(response.status).toBe(404);
    expect(readAuthoritativeTaskState).not.toHaveBeenCalled();
  });

  it('returns 404 when no orchestrator task document exists for this issue', async () => {
    readAuthoritativeTaskState.mockResolvedValue(undefined);

    const response = await GET(new Request('https://console.test/task-state'), {
      params,
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  // #1190: the 404 gate moved from an equality check against
  // `controlPlaneRepository()` to `isControlPlaneRepository()`'s allow-list
  // membership check.
  describe('repository allow-list (#1190)', () => {
    afterEach(() => {
      delete process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'];
    });

    it('admits a second repository once the allow-list env var lists it', async () => {
      process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
        'jlapenna/agent-lcars,other-org/other-repo';
      readAuthoritativeTaskState.mockResolvedValue({
        schema: 'agent-lcars.authoritative-task-state/v2',
        task: { repo: 'other-org/other-repo', issue: 5 },
        storageRevision: 1,
        updatedAt: '2026-08-09T00:00:00.000Z',
        activeRunId: 'other-org/other-repo#5/r1',
        runs: [],
      });

      const response = await GET(
        new Request('https://console.test/task-state'),
        {
          params: Promise.resolve({
            owner: 'other-org',
            repo: 'other-repo',
            issue: '5',
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(readAuthoritativeTaskState).toHaveBeenCalledWith({
        repository: 'other-org/other-repo',
        issue: 5,
      });
    });

    it('still 404s a repository absent from the configured allow-list', async () => {
      process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
        'jlapenna/agent-lcars,other-org/other-repo';

      const response = await GET(
        new Request('https://console.test/task-state'),
        {
          params: Promise.resolve({
            owner: 'unlisted-org',
            repo: 'unlisted-repo',
            issue: '5',
          }),
        },
      );

      expect(response.status).toBe(404);
      expect(readAuthoritativeTaskState).not.toHaveBeenCalled();
    });
  });
});
