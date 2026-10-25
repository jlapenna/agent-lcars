// @vitest-environment node
import {
  isRefusal,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { deriveItemState } from '@agent-lcars/work/derive';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publishFleetTriage } from './fleet-triage-publish';
import {
  triageMarker,
  type TriageSource,
  triageSourceKey,
} from './fleet-triage-source';
import { admitFleetTriage, parseTriageReport } from './fleet-triage-work';

const github = vi.hoisted(() => ({
  issues: {
    listLabelsForRepo: vi.fn(),
    addLabels: vi.fn(),
    createComment: vi.fn(),
    updateComment: vi.fn(),
    getComment: vi.fn(),
    get: vi.fn(),
  },
  graphql: vi.fn(),
}));
vi.mock('./github-client', () => ({ getGithubClient: () => github }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

async function fixture(initialComment?: string) {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, {
    now: () => new Date().toISOString(),
  });
  const runtime = { store, orchestrator };
  const anchor = { repo: 'owner/repo', issue: 7 };
  const source: TriageSource = {
    anchor,
    observedAt: new Date().toISOString(),
    title: 'A reproducible defect',
    body: 'The request fails.',
    state: 'open',
    labels: ['bug'],
    assignees: [],
    comments:
      initialComment === undefined
        ? []
        : [
            {
              id: 9,
              body: initialComment,
              updatedAt: new Date().toISOString(),
            },
          ],
    openFixPr: false,
    owned: false,
    parked: false,
    enabled: true,
  };
  const load = vi.fn(async () => {
    vi.setSystemTime(Date.now() + 1);
    return structuredClone({ ...source, observedAt: new Date().toISOString() });
  });
  const labelEvents: { createdAt: string; label: { name: string } }[] = [];
  github.issues.listLabelsForRepo.mockResolvedValue({
    data: [{ name: 'component:console' }, { name: 'type:bug' }],
  });
  github.issues.addLabels.mockImplementation(
    async ({ labels }: { labels: string[] }) => {
      for (const label of labels) {
        if (!source.labels.includes(label)) {
          source.labels.push(label);
          labelEvents.push({
            createdAt: new Date(
              Math.floor(Date.now() / 1000) * 1000,
            ).toISOString(),
            label: { name: label },
          });
        }
      }
      return { data: source.labels.map((name) => ({ name })) };
    },
  );
  github.issues.get.mockImplementation(async () => ({
    data: { labels: source.labels },
  }));
  github.issues.createComment.mockImplementation(
    async ({ body }: { body: string }) => {
      const comment = { id: 10, body, updatedAt: new Date().toISOString() };
      source.comments.push(comment);
      return { data: comment };
    },
  );
  github.issues.updateComment.mockImplementation(
    async ({ comment_id, body }: { comment_id: number; body: string }) => {
      const comment = source.comments.find((item) => item.id === comment_id)!;
      Object.assign(comment, { body, updatedAt: new Date().toISOString() });
      return { data: comment };
    },
  );
  github.issues.getComment.mockImplementation(
    async ({ comment_id }: { comment_id: number }) => ({
      data: source.comments.find((comment) => comment.id === comment_id),
    }),
  );
  github.graphql.mockImplementation(async () => ({
    repository: {
      issue: {
        timelineItems: {
          nodes: labelEvents,
          pageInfo: { hasPreviousPage: false },
        },
      },
    },
  }));
  await admitFleetTriage(runtime, anchor, load);
  const workId = (await store.readSourceWorkId(triageSourceKey(anchor)))!;
  const run = (await store.listRuns({ workId }))[0]!;
  const settle = async (
    ready = false,
    labels = ['component:console'],
    reportedRun = run,
  ) => {
    const message = JSON.stringify({
      sourceRevision: reportedRun.sourceRevision!.key,
      disposition: ready ? 'ready' : 'needs-evidence',
      summary: 'Investigated the failing request.',
      evidence: ['owner/repo@abc123: handler rejects the valid request'],
      acceptanceCriteria: ready
        ? ['The valid request returns 200 in a regression test.']
        : [],
      labels,
    });
    parseTriageReport(reportedRun, message);
    const result = await orchestrator.report(
      reportedRun.runId,
      { ok: true, summary: 'report', message },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    if (isRefusal(result)) throw new Error(result.reason);
    const entries = await store.claimPendingOutbox({
      now: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      limit: 10,
    });
    return entries.find((entry) => entry.kind === 'publish-triage')!;
  };
  const state = async () =>
    deriveItemState(
      (await store.readTask({ workId }))!.task,
      await store.listRuns({ workId }),
    );
  return {
    ...runtime,
    runtime,
    source,
    load,
    anchor,
    workId,
    run,
    settle,
    state,
    labelEvents,
  };
}

describe('event-driven triage effects', () => {
  it('deduplicates unchanged observations and preserves native dispatch parameters on a superseding input', async () => {
    const f = await fixture();
    await admitFleetTriage(f.runtime, f.anchor, f.load);
    expect(await f.store.listRuns({ workId: f.workId })).toHaveLength(1);
    f.source.body = 'Additional reproduction evidence.';
    await admitFleetTriage(f.runtime, f.anchor, f.load);
    const runs = await f.store.listRuns({ workId: f.workId });
    expect(runs).toHaveLength(2);
    expect(runs[0]?.state).toBe('canceled');
    expect(runs[1]?.params?.mode).toBe('implement');
  });

  it('keeps Work running until comment, metadata and final normal coding intake are observed', async () => {
    const f = await fixture();
    const entry = await f.settle(true);
    expect(await f.state()).toBe('running');
    await publishFleetTriage(f.store, entry, f.load);
    expect(await f.state()).toBe('done');
    expect(f.source.labels).toContain('agent:opencode');
    expect(github.issues.createComment).toHaveBeenCalledTimes(1);
    expect(github.issues.addLabels.mock.calls.at(-1)?.[0].labels).toEqual([
      'agent:opencode',
    ]);
    await publishFleetTriage(f.store, entry, f.load);
    expect(github.issues.createComment).toHaveBeenCalledTimes(1);
    expect(github.issues.addLabels).toHaveBeenCalledTimes(2);
  });

  it('recovers a lost create response without another comment', async () => {
    const f = await fixture();
    const entry = await f.settle();
    const create = github.issues.createComment.getMockImplementation()!;
    github.issues.createComment.mockImplementationOnce(async (input) => {
      await create(input);
      throw new Error('response lost');
    });
    await expect(publishFleetTriage(f.store, entry, f.load)).rejects.toThrow(
      'response lost',
    );
    await publishFleetTriage(f.store, entry, f.load);
    expect(github.issues.createComment).toHaveBeenCalledTimes(1);
    expect(await f.state()).toBe('done');
  });

  it('normalizes its own update while preserving a later human edit as new input', async () => {
    const f = await fixture(
      `${triageMarker({ repo: 'owner/repo', issue: 7 })}\nEarlier triage evidence`,
    );
    await publishFleetTriage(f.store, await f.settle(), f.load);
    await admitFleetTriage(f.runtime, f.anchor, f.load);
    expect(await f.store.listRuns({ workId: f.workId })).toHaveLength(1);
    f.source.comments[0]!.body += '\nA human correction';
    f.source.comments[0]!.updatedAt = new Date(Date.now() + 100).toISOString();
    await admitFleetTriage(f.runtime, f.anchor, f.load);
    expect(await f.store.listRuns({ workId: f.workId })).toHaveLength(2);
    expect(github.issues.updateComment).toHaveBeenCalledTimes(1);
  });

  it('never removes and re-adds a dispatch label after a lost response', async () => {
    const f = await fixture();
    const entry = await f.settle(true);
    const add = github.issues.addLabels.getMockImplementation()!;
    github.issues.addLabels.mockImplementation(async (input) => {
      const result = await add(input);
      if (input.labels.includes('agent:opencode')) {
        f.source.labels = f.source.labels.filter(
          (label) => label !== 'agent:opencode',
        );
        throw new Error('dispatch response lost');
      }
      return result;
    });
    await expect(publishFleetTriage(f.store, entry, f.load)).rejects.toThrow(
      'dispatch response lost',
    );
    await publishFleetTriage(f.store, entry, f.load);
    expect(
      github.issues.addLabels.mock.calls.filter(([input]) =>
        input.labels.includes('agent:opencode'),
      ),
    ).toHaveLength(1);
    expect(await f.state()).toBe('done');
  });

  it('publishes nothing after ownership changes', async () => {
    const f = await fixture();
    const entry = await f.settle(true);
    f.source.assignees = ['human'];
    await publishFleetTriage(f.store, entry, f.load);
    expect(github.issues.addLabels).not.toHaveBeenCalled();
    expect(github.issues.createComment).not.toHaveBeenCalled();
    expect((await f.store.readRun(f.run.runId))?.triagePublication?.state).toBe(
      'superseded',
    );
  });

  it('does not redispatch an issue in a later triage round after its dispatch label was removed', async () => {
    const f = await fixture();
    await publishFleetTriage(f.store, await f.settle(true), f.load);
    await admitFleetTriage(f.runtime, f.anchor, f.load);
    f.source.labels = f.source.labels.filter(
      (label) => label !== 'agent:opencode',
    );
    f.source.body += ' A later investigation is requested.';
    await admitFleetTriage(f.runtime, f.anchor, f.load);
    const latest = (await f.store.listRuns({ workId: f.workId })).at(-1)!;
    expect(latest.runId).not.toBe(f.run.runId);
    await publishFleetTriage(
      f.store,
      await f.settle(true, ['component:console'], latest),
      f.load,
    );
    expect(
      github.issues.addLabels.mock.calls.filter(([input]) =>
        input.labels.includes('agent:opencode'),
      ),
    ).toHaveLength(1);
    expect(f.source.labels).not.toContain('agent:opencode');
    expect(f.source.comments[0]?.body).toContain('no automatic redispatch');
    expect(await f.state()).toBe('done');
  });

  it('performs no external writes when its outbox lease has insufficient time', async () => {
    const f = await fixture();
    const entry = await f.settle();
    vi.setSystemTime(Date.parse(entry.leaseExpiresAt) - 1_000);
    await expect(publishFleetTriage(f.store, entry, f.load)).rejects.toThrow(
      'insufficient write budget',
    );
    expect(github.issues.addLabels).not.toHaveBeenCalled();
    expect(github.issues.createComment).not.toHaveBeenCalled();
  });

  it.each(['agent:codex', 'type:bug'])(
    'rejects generated control or eligibility label %s before any GitHub mutation',
    async (label) => {
      const f = await fixture();
      await publishFleetTriage(f.store, await f.settle(false, [label]), f.load);
      expect(await f.state()).toBe('failed');
      expect(github.issues.addLabels).not.toHaveBeenCalled();
      expect(github.issues.createComment).not.toHaveBeenCalled();
    },
  );
});
