import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('./github-client', () => ({
  getGithubClient: vi.fn(),
  getWatchedRepos: vi.fn(() => []),
}));

import { countMergedPullsSince } from './merged-pulls';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const SINCE = NOW - 24 * 60 * 60 * 1000;
const repos = [
  { owner: 'jlapenna', name: 'agent-lcars' },
  { owner: 'jlapenna', name: 'homelab' },
];

function page(nodes: { mergedAt: string | null; updatedAt: string }[]) {
  return { repository: { pullRequests: { nodes } } };
}

function client(byRepo: Record<string, unknown>) {
  return {
    graphql: vi.fn(async (_query: string, vars: Record<string, string>) => {
      const value = byRepo[vars['name'] ?? ''];
      if (value instanceof Error) throw value;
      return value;
    }),
  } as unknown as Parameters<typeof countMergedPullsSince>[1];
}

describe('countMergedPullsSince', () => {
  it('counts merges inside the window across every repository', async () => {
    const github = client({
      'agent-lcars': page([
        { mergedAt: '2026-10-14T11:00:00Z', updatedAt: '2026-10-14T11:01:00Z' },
        { mergedAt: '2026-10-13T13:00:00Z', updatedAt: '2026-10-13T13:00:00Z' },
        // Merged before the window, updated inside it.
        { mergedAt: '2026-10-12T09:00:00Z', updatedAt: '2026-10-13T20:00:00Z' },
      ]),
      homelab: page([
        { mergedAt: '2026-10-14T08:00:00Z', updatedAt: '2026-10-14T08:00:00Z' },
      ]),
    });
    await expect(countMergedPullsSince(SINCE, github, repos)).resolves.toEqual({
      count: 3,
      partial: false,
    });
  });

  it('reads a full page still inside the window as a lower bound', async () => {
    const nodes = Array.from({ length: 100 }, () => ({
      mergedAt: '2026-10-14T10:00:00Z',
      updatedAt: '2026-10-14T10:00:00Z',
    }));
    const github = client({ 'agent-lcars': page(nodes), homelab: page([]) });
    await expect(countMergedPullsSince(SINCE, github, repos)).resolves.toEqual({
      count: 100,
      partial: true,
    });
  });

  it('keeps the readable repositories and marks the count partial', async () => {
    const github = client({
      'agent-lcars': page([
        { mergedAt: '2026-10-14T11:00:00Z', updatedAt: '2026-10-14T11:00:00Z' },
      ]),
      homelab: new Error('boom'),
    });
    await expect(countMergedPullsSince(SINCE, github, repos)).resolves.toEqual({
      count: 1,
      partial: true,
    });
  });

  it('throws rather than report zero when nothing could be read', async () => {
    const github = client({
      'agent-lcars': new Error('boom'),
      homelab: { repository: null },
    });
    await expect(countMergedPullsSince(SINCE, github, repos)).rejects.toThrow(
      'Merged pull requests unavailable',
    );
  });
});
