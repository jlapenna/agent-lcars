import type { AgentEventSubscription } from '@agent-lcars/work';
import { describe, expect, it, vi } from 'vitest';

import { MemoryAgentEventSubscriptionStore } from './agent-event-store';
import {
  mergeabilityCandidates,
  mergeabilityTrigger,
  type PullRequestMergeability,
} from './github-pr-mergeability-events';

const repo = 'jlapenna/homelab';
const delivery = {
  event: 'push',
  deliveryId: 'base-push-1',
  receivedAt: '2026-11-25T12:00:00.000Z',
  payload: {
    repository: { full_name: repo },
    ref: 'refs/heads/main',
    deleted: false,
    sender: { login: 'jlapenna' },
  },
};
const state: PullRequestMergeability = {
  state: 'open',
  head: { sha: 'a'.repeat(40) },
  base: { ref: 'main', sha: 'b'.repeat(40) },
  mergeable: true,
  mergeable_state: 'behind',
};
async function subscriptions() {
  const store = new MemoryAgentEventSubscriptionStore();
  for (const [id, key, kinds] of [
    ['one', `github:pr:${repo}#7`, undefined],
    ['two', `github:pr:${repo}#7`, ['behind']],
    ['other-branch', `github:pr:${repo}#8`, undefined],
    ['reviews', `github:pr:${repo}#9`, ['review']],
    ['other-repo', 'github:pr:outside/upstream#7', undefined],
  ] as const) {
    await store.create({
      id,
      key,
      kinds,
      source: 'github:pr',
      target: { type: 'session', sessionId: id, host: 'pike' },
      createdAt: delivery.receivedAt,
    } as AgentEventSubscription);
  }
  return store;
}

describe('base branch pushes to agent events', () => {
  it('reads only affected subscribed PRs once, ignoring review-only subscriptions and other repositories', async () => {
    const read = vi.fn(async (_repo: string, number: number) => ({
      ...state,
      base: { ...state.base, ref: number === 8 ? 'release' : 'main' },
    }));
    const { candidates } = await mergeabilityCandidates(
      delivery,
      await subscriptions(),
      read,
    );
    expect(read.mock.calls).toEqual([
      [repo, 7],
      [repo, 8],
    ]);
    expect(candidates).toEqual([
      expect.objectContaining({
        key: `github:pr:${repo}#7`,
        kind: 'behind',
        actor: 'jlapenna',
        link: `https://github.com/${repo}/pull/7`,
      }),
    ]);
  });
  it('reports conflict after GitHub completes asynchronous mergeability calculation', async () => {
    const store = await subscriptions();
    await expect(
      mergeabilityCandidates(delivery, store, async () => ({
        ...state,
        mergeable: null,
        mergeable_state: 'unknown',
      })),
    ).resolves.toMatchObject({ retry: true });
    const { candidates } = await mergeabilityCandidates(
      delivery,
      store,
      async () => ({ ...state, mergeable: false, mergeable_state: 'dirty' }),
    );
    expect(candidates.map(({ kind }) => kind)).toEqual([
      'conflict',
      'conflict',
    ]);
    expect(candidates.map(({ id }) => id)).toEqual([
      'github.base-push-1.7.conflict',
      'github.base-push-1.8.conflict',
    ]);
  });
  it('does not report a closed or clean PR', async () => {
    const store = await subscriptions();
    expect(
      await mergeabilityCandidates(delivery, store, async () => ({
        ...state,
        state: 'closed',
      })),
    ).toEqual({ candidates: [], retry: false });
    expect(
      await mergeabilityCandidates(delivery, store, async () => ({
        ...state,
        mergeable_state: 'clean',
      })),
    ).toEqual({ candidates: [], retry: false });
  });
  it('does not consume tag pushes, branch deletion or unrelated event types', () => {
    expect(
      mergeabilityTrigger({
        ...delivery,
        payload: { ...delivery.payload, ref: 'refs/tags/v1' },
      }),
    ).toBeUndefined();
    expect(
      mergeabilityTrigger({
        ...delivery,
        payload: { ...delivery.payload, deleted: true },
      }),
    ).toBeUndefined();
    expect(
      mergeabilityTrigger({ ...delivery, event: 'issue_comment' }),
    ).toBeUndefined();
  });
  it('rereads a base retarget, but not title edits or edits by an untrusted author', async () => {
    const payload = {
      repository: { full_name: repo },
      action: 'edited',
      sender: { login: 'jlapenna' },
      changes: { base: { ref: { from: 'release' } } },
      pull_request: {
        number: 7,
        user: { login: 'jlapenna' },
        author_association: 'OWNER',
      },
    };
    const edited = { ...delivery, event: 'pull_request', payload };
    const result = await mergeabilityCandidates(
      edited,
      await subscriptions(),
      async () => ({ ...state, mergeable: false, mergeable_state: 'dirty' }),
    );
    expect(result.candidates.map(({ key, kind }) => ({ key, kind }))).toEqual([
      { key: `github:pr:${repo}#7`, kind: 'conflict' },
    ]);
    expect(
      mergeabilityTrigger({
        ...edited,
        payload: { ...payload, changes: { title: { from: 'old title' } } },
      }),
    ).toBeUndefined();
    expect(
      mergeabilityTrigger({
        ...edited,
        payload: {
          ...payload,
          sender: { login: 'outsider' },
          pull_request: {
            ...payload.pull_request,
            user: { login: 'outsider' },
            author_association: 'NONE',
          },
        },
      }),
    ).toBeUndefined();
  });

  it('uses the existing actor policy for a head push', () => {
    const payload = {
      action: 'synchronize',
      repository: { full_name: repo, html_url: `https://github.com/${repo}` },
      sender: { login: 'jlapenna' },
      pull_request: {
        number: 7,
        html_url: `https://github.com/${repo}/pull/7`,
        head: { sha: 'a'.repeat(40), repo: { full_name: repo } },
        user: { login: 'jlapenna' },
        author_association: 'OWNER',
      },
    };
    expect(
      mergeabilityTrigger({ ...delivery, event: 'pull_request', payload }),
    ).toMatchObject({ repository: repo, key: `github:pr:${repo}#7` });
  });
});
