import type { TrackerIssue } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import { decidedRun, isRefusal } from './decide';
import { MemoryStore } from './memory-store';
import { Orchestrator } from './orchestrator';
const issue: TrackerIssue = {
  reference: {
    tracker: 'linear',
    organizationId: '11111111-1111-4111-8111-111111111111',
    issueId: '44444444-4444-4444-8444-444444444444',
  },
  identifier: 'ENG-42',
  title: 'Initial title',
  description: 'Initial request',
  url: 'https://linear.app/example/issue/ENG-42',
  state: 'open',
  updatedAt: '2026-11-04T10:00:00.000Z',
  labels: [],
  assignees: [],
};
async function fixture(withSource = true) {
  let now = '2026-11-04T10:00:00.000Z';
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(
    store,
    { now: () => now },
    { pipelines: ['claude', 'codex'], allowedPipelines: () => ['codex'] },
  );
  const taskId = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E4H' };
  const first = await orchestrator.request({
    taskId,
    requestId: 'initial',
    pipeline: 'claude',
    params: { mode: 'implement' },
    work: { spec: { title: 'Stored work' } },
    ...(withSource ? { issue } : {}),
    providerFallback: {
      principal: 'user:operator',
      allowedPipelines: ['codex'],
    },
  });
  if (isRefusal(first)) throw new Error(first.reason);
  return {
    store,
    orchestrator,
    taskId,
    run: decidedRun(first),
    setNow: (value: string) => {
      now = value;
    },
  };
}
describe('issue source snapshot semantics', () => {
  it('retains admitted source across automatic loss retry while keeping newer Task metadata', async () => {
    const f = await fixture();
    await f.orchestrator.confirmDispatch(f.run.runId);
    await f.orchestrator.refreshIssue(f.taskId, {
      ...issue,
      description: 'New request',
      updatedAt: '2026-11-04T10:01:00.000Z',
    });
    f.setNow('2026-11-04T13:00:00.000Z');
    const result = await f.orchestrator.sweepExpired();
    expect(result.retried).toHaveLength(1);
    const next = await f.store.readRun(result.retried[0]!.newRunId);
    expect(next?.issue).toEqual(issue);
    expect((await f.store.readTask(f.taskId))?.task.issue?.description).toBe(
      'New request',
    );
  });
  it('keeps the original source snapshot across provider-limit fallback', async () => {
    const f = await fixture();
    await f.orchestrator.refreshIssue(f.taskId, {
      ...issue,
      title: 'Later edit',
      updatedAt: '2026-11-04T10:01:00.000Z',
    });
    const result = await f.orchestrator.report(f.run.runId, {
      ok: false,
      summary: 'provider-limit',
    });
    if (isRefusal(result)) throw new Error(result.reason);
    expect(result.additionalRuns?.[0]).toMatchObject({
      pipeline: 'codex',
      issue,
    });
    expect((await f.store.readTask(f.taskId))?.task.issue?.title).toBe(
      'Later edit',
    );
  });
  it('does not invent a source on an automatic retry of a legacy run', async () => {
    const f = await fixture(false);
    await f.orchestrator.confirmDispatch(f.run.runId);
    await f.orchestrator.refreshIssue(f.taskId, issue);
    f.setNow('2026-11-04T13:00:00.000Z');
    const result = await f.orchestrator.sweepExpired();
    expect(
      (await f.store.readRun(result.retried[0]!.newRunId))?.issue,
    ).toBeUndefined();
  });
  it('copies a fresh current snapshot for an explicit new turn and rejects identity changes', async () => {
    const f = await fixture();
    await f.orchestrator.confirmDispatch(f.run.runId);
    await f.orchestrator.report(f.run.runId, { ok: true, summary: 'done' });
    const edited = {
      ...issue,
      description: 'New request',
      updatedAt: '2026-11-04T10:01:00.000Z',
    };
    await f.orchestrator.refreshIssue(f.taskId, edited);
    const next = await f.orchestrator.request({
      taskId: f.taskId,
      requestId: 'human-follow-up',
      pipeline: 'claude',
      params: { mode: 'reply' },
    });
    if (isRefusal(next)) throw new Error(next.reason);
    expect(decidedRun(next).issue).toEqual(edited);
    expect((await f.store.readRun(f.run.runId))?.issue).toEqual(issue);
    await expect(
      f.orchestrator.refreshIssue(f.taskId, {
        ...edited,
        reference: { tracker: 'github', repo: 'owner/repo', issue: 42 },
      }),
    ).rejects.toThrow('identity');
  });
});
