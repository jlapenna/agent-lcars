import {
  type GithubAnchorProjection,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { describe, expect, it, vi } from 'vitest';

import {
  excludeClosedGithubAnchors,
  listAdmittedNativeWork,
  listWorkSummaries,
} from './work-summary';

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
          state: 'failed',
        }),
        expect.objectContaining({
          id: `work:${nativeId}`,
          anchor: { workId: nativeId },
          state: 'running',
        }),
      ]),
    );
  });

  it('visits 205 tasks exactly once and finds an older park after an empty filtered page', async () => {
    const { store, orchestrator } = fixture();
    const ids: string[] = [];
    for (let issue = 1; issue <= 205; issue++) {
      const result = await orchestrator.request({
        taskId: { repo: 'jlapenna/agent-lcars', issue },
        requestId: `page-${issue}`,
        pipeline: 'claude',
        work: payload,
      });
      if ('refused' in result) throw new Error(result.reason);
      ids.push(`jlapenna/agent-lcars#${issue}`);
      if (issue === 1) {
        await orchestrator.confirmDispatch(result.run.runId);
        await orchestrator.report(result.run.runId, {
          ok: true,
          summary: 'park',
        });
      }
    }
    const first = await listWorkSummaries(store, { limit: 200 });
    const second = await listWorkSummaries(store, {
      limit: 200,
      cursor: first.nextCursor,
    });
    const visited = [...first.items, ...second.items].map((item) => item.id);
    expect(visited).toHaveLength(205);
    expect(new Set(visited).size).toBe(205);
    expect(visited.sort()).toEqual(ids.sort());
    expect(second.nextCursor).toBeUndefined();
    const empty = await listWorkSummaries(store, {
      limit: 200,
      state: 'parked',
    });
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).toBeDefined();
    const older = await listWorkSummaries(store, {
      limit: 200,
      state: 'parked',
      cursor: empty.nextCursor,
    });
    expect(older.items.map((item) => item.id)).toEqual([
      'jlapenna/agent-lcars#1',
    ]);
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
    await orchestrator.report(parked.run.runId, { ok: true, summary: 'park' });

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
    await orchestrator.report(github.run.runId, { ok: true, summary: 'park' });
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
    await orchestrator.report(github.run.runId, { ok: true, summary: 'park' });
    await orchestrator.confirmDispatch(native.run.runId);
    await orchestrator.report(native.run.runId, { ok: true, summary: 'park' });
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
    await orchestrator.report(github.run.runId, { ok: true, summary: 'park' });

    const page = await listWorkSummaries(store, { limit: 10, state: 'parked' });
    const items = await excludeClosedGithubAnchors(store, page.items);
    expect(items.map((item) => item.id)).toEqual(['jlapenna/agent-lcars#1502']);
  });
});

describe('listAdmittedNativeWork', () => {
  it('returns only running native Work items and excludes GitHub, parked, failed, and done items', async () => {
    const { store, orchestrator } = fixture();
    const runningId = '01J5Z3K9QX8F0N2B4V6C8D1E3A';
    const parkedId = '01J5Z3K9QX8F0N2B4V6C8D1E3B';
    const failedId = '01J5Z3K9QX8F0N2B4V6C8D1E3C';
    const doneId = '01J5Z3K9QX8F0N2B4V6C8D1E3D';
    const running = await orchestrator.request({
      taskId: { workId: runningId },
      requestId: runningId,
      pipeline: 'claude',
      work: payload,
    });
    const parked = await orchestrator.request({
      taskId: { workId: parkedId },
      requestId: parkedId,
      pipeline: 'claude',
      work: payload,
    });
    const failed = await orchestrator.request({
      taskId: { workId: failedId },
      requestId: failedId,
      pipeline: 'claude',
      work: payload,
    });
    const done = await orchestrator.request({
      taskId: { workId: doneId },
      requestId: doneId,
      pipeline: 'claude',
      work: payload,
    });
    const github = await orchestrator.request({
      taskId: { repo: 'jlapenna/agent-lcars', issue: 1502 },
      requestId: 'github-running',
      pipeline: 'claude',
      work: payload,
    });
    if (
      'refused' in running ||
      'refused' in parked ||
      'refused' in failed ||
      'refused' in done ||
      'refused' in github
    )
      throw new Error('expected task requests to succeed');

    await orchestrator.confirmDispatch(parked.run.runId);
    await orchestrator.report(parked.run.runId, { ok: true, summary: 'park' });
    await orchestrator.confirmDispatch(failed.run.runId);
    await orchestrator.report(failed.run.runId, { ok: false, summary: 'fail' });
    await orchestrator.confirmDispatch(done.run.runId);
    await orchestrator.report(done.run.runId, { ok: true, summary: 'done' });

    const page = await listAdmittedNativeWork(store, {
      principal: {},
      limit: 200,
    });
    expect(page.hasMore).toBe(false);
    expect(page.items.map((item) => item.id)).toEqual([runningId]);
    expect(page.items[0]?.state).toBe('running');
  });

  it('marks hasMore when the raw page fills the limit and skips run reads when empty', async () => {
    const { store, orchestrator } = fixture();
    const listRunsForTasks = vi.spyOn(store, 'listRunsForTasks');

    const empty = await listAdmittedNativeWork(store, {
      principal: {},
      limit: 10,
    });
    expect(empty).toEqual({ items: [], hasMore: false });
    expect(listRunsForTasks).not.toHaveBeenCalled();

    for (const workId of [
      '01J5Z3K9QX8F0N2B4V6C8D1E3E',
      '01J5Z3K9QX8F0N2B4V6C8D1E3F',
    ]) {
      const result = await orchestrator.request({
        taskId: { workId },
        requestId: workId,
        pipeline: 'claude',
        work: payload,
      });
      if ('refused' in result) throw new Error(result.reason);
    }

    const bounded = await listAdmittedNativeWork(store, {
      principal: {},
      limit: 2,
    });
    expect(bounded.items).toHaveLength(2);
    expect(bounded.hasMore).toBe(true);
  });

  it('scopes repository-bound principals without filtering store pages by state', async () => {
    const { store, orchestrator } = fixture();
    const listNativeTasks = vi.spyOn(store, 'listNativeTasks');
    const allowedId = '01J5Z3K9QX8F0N2B4V6C8D1E3H';
    const otherId = '01J5Z3K9QX8F0N2B4V6C8D1E3J';

    const allowed = await orchestrator.request({
      taskId: { workId: allowedId },
      requestId: allowedId,
      pipeline: 'claude',
      work: payload,
    });
    const other = await orchestrator.request({
      taskId: { workId: otherId },
      requestId: otherId,
      pipeline: 'claude',
      work: {
        ...payload,
        spec: {
          ...payload.spec,
          target: { repo: 'jlapenna/homelab' },
        },
      },
    });
    if ('refused' in allowed || 'refused' in other)
      throw new Error('expected task requests to succeed');

    const page = await listAdmittedNativeWork(store, {
      principal: { sourceRepository: 'jlapenna/agent-lcars' },
      limit: 200,
    });
    expect(listNativeTasks).toHaveBeenCalledWith(200, undefined, undefined);
    expect(page.items.map((item) => item.id)).toEqual([allowedId]);
  });

  it('includes a delivery-waiting native Work item that has no live run', async () => {
    const { store, orchestrator } = fixture();
    const deliveryId = '01J5Z3K9QX8F0N2B4V6C8D1E3K';
    const created = await orchestrator.request({
      taskId: { workId: deliveryId },
      requestId: deliveryId,
      pipeline: 'claude',
      work: payload,
    });
    if ('refused' in created) throw new Error(created.reason);
    await orchestrator.confirmDispatch(created.run.runId);
    await orchestrator.report(
      created.run.runId,
      {
        ok: true,
        summary: 'pr',
        ref: 'https://github.com/jlapenna/agent-lcars/pull/9999',
      },
      undefined,
      undefined,
      {
        runId: created.run.runId,
        repo: 'jlapenna/agent-lcars',
        number: 9999,
        baseRef: 'main',
        head: 'a'.repeat(40),
        state: 'waiting',
        observedAt: T,
      },
    );

    const page = await listAdmittedNativeWork(store, {
      principal: {},
      limit: 200,
    });
    expect(page.items.map((item) => item.id)).toEqual([deliveryId]);
    expect(page.items[0]?.state).toBe('running');
  });
});
