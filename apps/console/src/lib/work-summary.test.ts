import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import { listAllParkedWorkSummaries, listWorkSummaries } from './work-summary';

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

  it('keeps paging after an empty filtered page so older parked work is visible', async () => {
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
    // be empty after state filtering, but the Bridge helper walks on.
    const first = await listWorkSummaries(store, { limit: 1, state: 'parked' });
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBeDefined();
    const allParked = await listAllParkedWorkSummaries(store, 1);
    expect(allParked.map((item) => item.id)).toContain(
      'jlapenna/agent-lcars#1',
    );
  });

  it('omits legacy tasks that have no work payload instead of failing the page', async () => {
    const { store, orchestrator } = fixture();
    await orchestrator.request({
      taskId: { repo: 'jlapenna/agent-lcars', issue: 3 },
      requestId: 'legacy',
      pipeline: 'claude',
    });
    const page = await listWorkSummaries(store, { limit: 10 });
    expect(page.items).toEqual([]);
  });
});
