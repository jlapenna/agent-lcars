import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    schema: 'agent-lcars.authoritative-task-state/v1',
    task: {
      repositoryId: 1_307_149_765,
      repository: 'jlapenna/agent-lcars',
      issue: 824,
    },
    storageRevision: 9,
    updatedAt: '2026-08-09T00:00:00.000Z',
    controllerState: { revision: 7 },
  });
});

describe('GET /api/control-plane/task-state/:owner/:repo/:issue', () => {
  it('returns the exact no-store authoritative aggregate', async () => {
    const response = await GET(
      new Request('https://console.test/task-state?repositoryId=1307149765'),
      { params },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(readAuthoritativeTaskState).toHaveBeenCalledWith({
      repositoryId: 1_307_149_765,
      repository: 'jlapenna/agent-lcars',
      issue: 824,
    });
    await expect(response.json()).resolves.toMatchObject({
      storageRevision: 9,
    });
  });

  it('fails closed before storage for another repository', async () => {
    const response = await GET(
      new Request('https://console.test/task-state?repositoryId=1307149765'),
      {
        params: Promise.resolve({
          owner: 'someone',
          repo: 'elsewhere',
          issue: '824',
        }),
      },
    );
    expect(response.status).toBe(404);
    expect(readAuthoritativeTaskState).not.toHaveBeenCalled();
  });
});
