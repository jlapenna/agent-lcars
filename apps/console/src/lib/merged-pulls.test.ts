import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('./github-client', () => ({ getWatchedRepos: vi.fn(() => []) }));
vi.mock('./orchestrator-runtime', () => ({
  createOrchestratorRuntime: vi.fn(),
}));

import { countMergedPullsSince } from './merged-pulls';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const SINCE = NOW - 24 * 60 * 60 * 1000;
const repos = [
  { owner: 'jlapenna', name: 'agent-lcars' },
  { owner: 'jlapenna', name: 'homelab' },
];

function store(anchors: { repo: string; issue: number }[]) {
  return { listGithubAnchorsMergedSince: vi.fn(async () => anchors) };
}

describe('countMergedPullsSince', () => {
  it('counts stored merges in the watched repositories since the cutoff', async () => {
    const merged = store([
      { repo: 'jlapenna/agent-lcars', issue: 1 },
      { repo: 'jlapenna/agent-lcars', issue: 2 },
      { repo: 'jlapenna/homelab', issue: 3 },
      // Not watched by this page: never counted.
      { repo: 'jlapenna/labels', issue: 4 },
    ]);

    await expect(countMergedPullsSince(SINCE, merged, repos)).resolves.toEqual({
      count: 3,
      partial: false,
    });
    expect(merged.listGithubAnchorsMergedSince).toHaveBeenCalledWith(
      '2026-11-24T12:00:00.000Z',
    );
  });

  it('scopes the count to the repositories it is given', async () => {
    await expect(
      countMergedPullsSince(
        SINCE,
        store([
          { repo: 'jlapenna/agent-lcars', issue: 1 },
          { repo: 'jlapenna/homelab', issue: 3 },
        ]),
        [{ owner: 'jlapenna', name: 'homelab' }],
      ),
    ).resolves.toEqual({ count: 1, partial: false });
  });

  it('fails rather than reporting zero when the store cannot be read', async () => {
    const failing = {
      listGithubAnchorsMergedSince: vi.fn(async () => {
        throw new Error('unavailable');
      }),
    };
    await expect(countMergedPullsSince(SINCE, failing, repos)).rejects.toThrow(
      'unavailable',
    );
  });
});
