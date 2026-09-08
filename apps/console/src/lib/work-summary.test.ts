import {
  type GithubAnchorProjection,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import { excludeClosedGithubAnchors, listWorkSummaries } from './work-summary';

const T = '2026-08-28T10:00:00.000Z';
const nativeId = '01J5Z3K9QX8F0N2B4V6C8D1E3G';
const payload = {
  origin: { principal: 'github:jlapenna', channel: 'github' as const },
  spec: {
    title: 'Work title',
    description: 'Work description',
    pipeline: 'claude' as const,
    target: { repo: 'jlapenna/agent-lcars' },
  },
};

function fixture() {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, { now: () => T });
  return { store, orchestrator };
}

describe('listWorkSummaries', () => {
  it('projects GitHub and native anchors from task/run truth with stable IDs', async () => {
    const { store, orchestrator } = fixture();
    const github = await orchestrator.request({
      taskId: { repo: 'jlapenna/agent-lcars', issue: 1502 },
      requestId: 'github',
      pipeline: 'claude',
      work: payload,
    });
    const native = await orchestrator.request({
      taskId: { workId: nativeId },
      requestId: nativeId,
      pipeline: 'claude',
      work: payload,
    });
    if ('refused' in github || 'refused' in native)
      throw new Error('expected task requests to succeed');

    await orchestrator.confirmDispatch(github.run.runId);
    await orchestrator.report(github.run.runId, {
      ok: false,
      summary: 'needs attention',
    });

    const page = await listWorkSummaries(store, { limit: 10 });
    expect(page.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'jlapenna/agent-lcars#1502',
          anchor: { repo: 'jlapenna/agent-lcars', issue: 1502 },
          state: 'parked',
        }),
        expect.objectContaining({
          id: `work:${nativeId}`,
          anchor: { workId: nativeId },
          state: 'running',
        }),
      ]),
    );
  });

  it('keeps a stable cursor after an empty filtered page', async () => {
    const { store, orchestrator } = fixture();
    const parked = await orchestrator.request({
      taskId: { repo: 'jlapenna/agent-lcars', issue: 1 },
      requestId: 'parked',
      pipeline: 'claude',
      work: payload,
    });
    const running = await orchestrator.request({
      taskId: { repo: 'jlapenna/agent-lcars', issue: 2 },
      requestId: 'running',
      pipeline: 'claude',
      work: payload,
    });
    if ('refused' in parked || 'refused' in running)
      throw new Error('expected task requests to succeed');
    await orchestrator.confirmDispatch(parked.run.runId);
    await orchestrator.report(parked.run.runId, { ok: false });

    // Same instant orders by anchor key. A one-row raw page can legitimately
    // be empty after state filtering, but the cursor still makes the next
    // bounded page available to a paginated console consumer.
    const first = await listWorkSummaries(store, { limit: 1, state: 'parked' });
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBeDefined();
    const second = await listWorkSummaries(store, {
      limit: 1,
      cursor: first.nextCursor,
      state: 'parked',
    });
    expect(second.items.map((item) => item.id)).toContain(
      'jlapenna/agent-lcars#1',
    );
  });
});

describe('excludeClosedGithubAnchors', () => {
  const projectionBase: Omit<GithubAnchorProjection, 'anchor' | 'state'> = {
    kind: 'issue',
    title: 'Anchor',
    body: '',
    url: 'https://github.com/jlapenna/agent-lcars/issues/1502',
    labels: [],
    assigneeLogins: [],
    sourceUpdatedAt: T,
    observedAt: T,
  };

  async function projectAnchorState(
    store: MemoryStore,
    anchor: GithubAnchorProjection['anchor'],
    state: GithubAnchorProjection['state'],
  ) {
    const generation = await store.beginGithubAnchorProjectionRefresh(anchor);
    await store.applyGithubAnchorProjectionRefresh({
      anchor,
      generation,
      projection: { ...projectionBase, anchor, state },
    });
  }

  it('drops a parked GitHub item whose issue is closed on GitHub (#1860)', async () => {
    const { store, orchestrator } = fixture();
    const github = await orchestrator.request({
      taskId: { repo: 'jlapenna/agent-lcars', issue: 1502 },
      requestId: 'github',
      pipeline: 'claude',
      work: payload,
    });
    if ('refused' in github)
      throw new Error('expected task request to succeed');
    await orchestrator.confirmDispatch(github.run.runId);
    await orchestrator.report(github.run.runId, { ok: false });
    await projectAnchorState(
      store,
      { repo: 'jlapenna/agent-lcars', issue: 1502 },
      'closed',
    );

    const page = await listWorkSummaries(store, { limit: 10, state: 'parked' });
    const items = await excludeClosedGithubAnchors(store, page.items);
    expect(items).toEqual([]);
  });

  it('keeps a parked GitHub item whose issue is still open, and every native item untouched', async () => {
    const { store, orchestrator } = fixture();
    const github = await orchestrator.request({
      taskId: { repo: 'jlapenna/agent-lcars', issue: 1502 },
      requestId: 'github',
      pipeline: 'claude',
      work: payload,
    });
    const native = await orchestrator.request({
      taskId: { workId: nativeId },
      requestId: nativeId,
      pipeline: 'claude',
      work: payload,
    });
    if ('refused' in github || 'refused' in native)
      throw new Error('expected task requests to succeed');
    await orchestrator.confirmDispatch(github.run.runId);
    await orchestrator.report(github.run.runId, { ok: false });
    await orchestrator.confirmDispatch(native.run.runId);
    await orchestrator.report(native.run.runId, { ok: false });
    await projectAnchorState(
      store,
      { repo: 'jlapenna/agent-lcars', issue: 1502 },
      'open',
    );

    const page = await listWorkSummaries(store, { limit: 10, state: 'parked' });
    const items = await excludeClosedGithubAnchors(store, page.items);
    expect(items.map((item) => item.id).sort()).toEqual(
      ['jlapenna/agent-lcars#1502', `work:${nativeId}`].sort(),
    );
  });

  it('keeps a parked GitHub item with no stored projection (fails open)', async () => {
    const { store, orchestrator } = fixture();
    const github = await orchestrator.request({
      taskId: { repo: 'jlapenna/agent-lcars', issue: 1502 },
      requestId: 'github',
      pipeline: 'claude',
      work: payload,
    });
    if ('refused' in github)
      throw new Error('expected task request to succeed');
    await orchestrator.confirmDispatch(github.run.runId);
    await orchestrator.report(github.run.runId, { ok: false });

    const page = await listWorkSummaries(store, { limit: 10, state: 'parked' });
    const items = await excludeClosedGithubAnchors(store, page.items);
    expect(items.map((item) => item.id)).toEqual(['jlapenna/agent-lcars#1502']);
  });
});
