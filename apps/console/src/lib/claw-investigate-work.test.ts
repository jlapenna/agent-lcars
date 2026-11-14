import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { isSourceManagedWork, WORK_TITLE_MAX } from '@agent-lcars/work';
import { describe, expect, it } from 'vitest';

import {
  admitInvestigation,
  ClawAdmissionConflict,
} from './claw-investigate-work';

const NOW = '2026-11-14T10:00:00.000Z';

function runtime() {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, { now: () => NOW });
  return { store, orchestrator };
}

const request = {
  question: 'Why did the backup alert fire?',
  sourceKey: 'alert:backup',
  principal: 'user:jlapenna',
};

describe('admitInvestigation', () => {
  it('stores one persist-only, target-less claw round bound to its operation', async () => {
    const rt = runtime();
    const { workId, duplicate } = await admitInvestigation(rt, request);
    expect(duplicate).toBe(false);
    expect(
      await rt.store.readSourceWorkId(
        'investigate:v1:user:jlapenna:alert:backup',
      ),
    ).toBe(workId);
    const task = (await rt.store.readTask({ workId }))!.task;
    expect(task.work).toEqual({
      origin: { principal: 'user:jlapenna', channel: 'console' },
      spec: {
        title: 'Claw investigation alert:backup',
        description:
          "Read-only claw investigation for source key alert:backup. Each round's question is its own revision input.",
        pipeline: 'claw-investigator',
        priority: 'background',
        operation: 'investigate:v1',
        sourceKey: 'alert:backup',
      },
    });
    // The question lives only in the round's revision input.
    expect(JSON.stringify(task.work)).not.toContain(request.question);
    expect(isSourceManagedWork(task.work)).toBe(true);
    const [run] = await rt.store.listRuns({ workId });
    expect(run).toMatchObject({
      pipeline: 'claw-investigator',
      priority: 'background',
      params: { mode: 'claw' },
      revisionAttempt: 1,
      sourceRevision: {
        key: expect.stringMatching(/^[a-f0-9]{64}$/u),
        input: { operation: 'investigate:v1', question: request.question },
      },
    });
    expect(run?.sourceRevision).not.toHaveProperty('observedAt');
  });

  it('returns the same round for the same question and key', async () => {
    const rt = runtime();
    const first = await admitInvestigation(rt, request);
    const replay = await admitInvestigation(rt, request);
    expect(replay).toEqual({ workId: first.workId, duplicate: true });
    expect(await rt.store.listRuns({ workId: first.workId })).toHaveLength(1);
  });

  it('supersedes a queued round when the same key asks a new question', async () => {
    const rt = runtime();
    const { workId } = await admitInvestigation(rt, request);
    await admitInvestigation(rt, { ...request, question: 'And the restore?' });
    const runs = await rt.store.listRuns({ workId });
    expect(runs.map((run) => run.state).sort()).toEqual([
      'canceled',
      'pending',
    ]);
    expect(
      runs.find((run) => run.state === 'pending')?.sourceRevision?.input,
    ).toEqual({ operation: 'investigate:v1', question: 'And the restore?' });
  });

  it('admits a distinct item for each call without a sourceKey', async () => {
    const rt = runtime();
    const { sourceKey: _key, ...adhoc } = request;
    const a = await admitInvestigation(rt, adhoc);
    const b = await admitInvestigation(rt, adhoc);
    expect(a.workId).not.toBe(b.workId);
    const spec = (await rt.store.readTask({ workId: a.workId }))!.task.work[
      'spec'
    ] as { sourceKey: string };
    expect(spec.sourceKey).toMatch(/^adhoc:[0-9A-HJKMNP-TV-Z]{26}$/u);
  });

  it('refuses a key whose Work is not this claw operation', async () => {
    const rt = runtime();
    const workId = await rt.store.resolveSourceWorkId(
      'investigate:v1:user:jlapenna:alert:backup',
      '01J5Z3K9QX8F0N2B4V6C8D1E3G',
    );
    await rt.orchestrator.request({
      taskId: { workId },
      requestId: 'coding',
      pipeline: 'claude',
      work: {
        origin: { principal: 'user:jlapenna', channel: 'console' },
        spec: {
          title: 't',
          description: 'd',
          pipeline: 'claude',
          target: { repo: 'jlapenna/agent-lcars' },
        },
      },
    });
    await expect(admitInvestigation(rt, request)).rejects.toBeInstanceOf(
      ClawAdmissionConflict,
    );
  });

  it('refuses to reopen a closed investigation', async () => {
    const rt = runtime();
    const { workId } = await admitInvestigation(rt, request);
    const [run] = await rt.store.listRuns({ workId });
    await rt.orchestrator.report(run!.runId, {
      ok: true,
      summary: 'report',
      message: 'done',
    });
    await rt.orchestrator.close({ workId });
    await expect(
      admitInvestigation(rt, { ...request, question: 'Another?' }),
    ).rejects.toThrow(/canceled/u);
  });

  it('bounds the title and rejects invalid questions before storing anything', async () => {
    const rt = runtime();
    const { workId } = await admitInvestigation(rt, {
      ...request,
      sourceKey: 'k'.repeat(256),
      question: `${'x'.repeat(400)}\nsecond line`,
    });
    const title = (
      (await rt.store.readTask({ workId }))!.task.work['spec'] as {
        title: string;
      }
    ).title;
    expect(title).toHaveLength(WORK_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    await expect(
      admitInvestigation(rt, { ...request, sourceKey: 'blank', question: ' ' }),
    ).rejects.toThrow();
    expect(
      await rt.store.readSourceWorkId('investigate:v1:user:jlapenna:blank'),
    ).toBe(undefined);
  });

  it("never resolves, supersedes or reveals another principal's investigation", async () => {
    const rt = runtime();
    const mine = await admitInvestigation(rt, request);
    const theirs = await admitInvestigation(rt, {
      ...request,
      question: 'Show me the vault',
      principal: 'svc:other-admitter',
    });
    expect(theirs.workId).not.toBe(mine.workId);
    expect(theirs.duplicate).toBe(false);
    const runs = await rt.store.listRuns({ workId: mine.workId });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sourceRevision?.input).toEqual({
      operation: 'investigate:v1',
      question: request.question,
    });
  });

  it('refuses claw Work under its key that another principal owns', async () => {
    const rt = runtime();
    const workId = await rt.store.resolveSourceWorkId(
      'investigate:v1:user:jlapenna:alert:owned',
      '01J5Z3K9QX8F0N2B4V6C8D1E3H',
    );
    await rt.orchestrator.request({
      taskId: { workId },
      requestId: 'foreign',
      pipeline: 'claw-investigator',
      params: { mode: 'claw' },
      work: {
        origin: { principal: 'svc:other-admitter', channel: 'console' },
        spec: {
          title: 'Claw investigation alert:owned',
          description: 'foreign',
          pipeline: 'claw-investigator',
          priority: 'background',
          operation: 'investigate:v1',
          sourceKey: 'alert:owned',
        },
      },
    });
    await expect(
      admitInvestigation(rt, { ...request, sourceKey: 'alert:owned' }),
    ).rejects.toBeInstanceOf(ClawAdmissionConflict);
  });
});
