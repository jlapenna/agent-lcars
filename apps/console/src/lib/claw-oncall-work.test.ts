import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import { admitInvestigation } from './claw-investigate-work';
import {
  admitOncallAlert,
  oncallRevisionKey,
  resolveOncallAlert,
} from './claw-oncall-work';

const NOW = '2026-11-14T10:00:00.000Z';
const GATE = 'svc:oncall-alert-gate';
const A = '0123456789abcdef';
const B = 'fedcba9876543210';

function runtime() {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, { now: () => NOW });
  return { store, orchestrator };
}

const request = {
  groupKey: 'page:HostDiskFull:riker',
  fingerprints: [A],
  episode: '2026-11-14T09:58:00Z',
  question: 'Alert HostDiskFull is firing on riker.',
  principal: GATE,
};

describe('admitOncallAlert', () => {
  it('stores one persist-only alertmanager round bound to oncall-investigate:v1', async () => {
    const rt = runtime();
    const { workId, duplicate } = await admitOncallAlert(rt, request);
    expect(duplicate).toBe(false);
    expect(
      await rt.store.readSourceWorkId(
        `oncall-investigate:v1:${GATE}:page:HostDiskFull:riker`,
      ),
    ).toBe(workId);
    const task = (await rt.store.readTask({ workId }))!.task;
    expect(task.work).toEqual({
      // No thread: shadow-stage outcomes are persisted, never delivered.
      origin: { principal: GATE, channel: 'alertmanager' },
      spec: {
        title: 'Oncall alert group page:HostDiskFull:riker',
        description:
          "claw/oncall investigation of Alertmanager group page:HostDiskFull:riker. Each fingerprint set is one revision; its alert text is that revision's input.",
        pipeline: 'claw-oncall',
        priority: 'urgent',
        operation: 'oncall-investigate:v1',
        sourceKey: 'page:HostDiskFull:riker',
      },
    });
    const [run] = await rt.store.listRuns({ workId });
    expect(run).toMatchObject({
      pipeline: 'claw-oncall',
      params: { mode: 'claw' },
      sourceRevision: {
        key: oncallRevisionKey([A], request.episode),
        input: {
          operation: 'oncall-investigate:v1',
          question: request.question,
        },
      },
    });
  });

  it('keys the revision by the deduplicated, order-independent fingerprint set', () => {
    expect(oncallRevisionKey([B, A, B])).toBe(oncallRevisionKey([A, B]));
    expect(oncallRevisionKey([A])).not.toBe(oncallRevisionKey([A, B]));
    expect(oncallRevisionKey([A], 'e1')).not.toBe(oncallRevisionKey([A], 'e2'));
    expect(oncallRevisionKey([A], undefined)).not.toBe(
      oncallRevisionKey([A], 'e1'),
    );
  });

  it('returns the same round for the same fingerprints even when the alert text differs', async () => {
    const rt = runtime();
    const first = await admitOncallAlert(rt, request);
    expect(await admitOncallAlert(rt, request)).toEqual({
      workId: first.workId,
      duplicate: true,
    });
    expect(
      await admitOncallAlert(rt, {
        ...request,
        question: 'Alert HostDiskFull is firing on riker (re-rendered).',
      }),
    ).toEqual({ workId: first.workId, duplicate: true });
    expect(await rt.store.listRuns({ workId: first.workId })).toHaveLength(1);
  });

  it('supersedes a queued round when the group gains a fingerprint', async () => {
    const rt = runtime();
    const { workId } = await admitOncallAlert(rt, request);
    await admitOncallAlert(rt, { ...request, fingerprints: [A, B] });
    const runs = await rt.store.listRuns({ workId });
    expect(runs.map((run) => run.state).sort()).toEqual([
      'canceled',
      'pending',
    ]);
  });

  it("never resolves to another principal's group or to non-oncall Work", async () => {
    const rt = runtime();
    const gate = await admitOncallAlert(rt, request);
    const other = await admitOncallAlert(rt, {
      ...request,
      principal: 'svc:other-gate',
    });
    expect(other.workId).not.toBe(gate.workId);
    // An investigation's key space is disjoint from an oncall group's.
    const investigation = await admitInvestigation(rt, {
      question: 'Why?',
      sourceKey: request.groupKey,
      principal: GATE,
    });
    expect(investigation.workId).not.toBe(gate.workId);
  });
});

describe('resolveOncallAlert', () => {
  it('admits a new round when the group re-fires with the same fingerprints in a new episode', async () => {
    const rt = runtime();
    const { workId } = await admitOncallAlert(rt, request);
    await resolveOncallAlert(
      rt,
      { groupKey: request.groupKey, principal: GATE },
      '2026-11-14T10:05:00.000Z',
    );
    // The same episode stays the resolved round, never a new one.
    expect(await admitOncallAlert(rt, request)).toEqual({
      workId,
      duplicate: true,
    });
    const refire = await admitOncallAlert(rt, {
      ...request,
      episode: '2026-11-14T10:20:00Z',
    });
    expect(refire).toEqual({ workId, duplicate: false });
    const runs = await rt.store.listRuns({ workId });
    expect(runs.map((run) => run.state).sort()).toEqual([
      'canceled',
      'pending',
    ]);
  });

  it('cancels a pending round and admits no successor', async () => {
    const rt = runtime();
    const { workId } = await admitOncallAlert(rt, request);
    expect(
      await resolveOncallAlert(
        rt,
        { groupKey: request.groupKey, principal: GATE },
        '2026-11-14T10:05:00.000Z',
      ),
    ).toEqual({ workId, invalidated: true });
    const runs = await rt.store.listRuns({ workId });
    expect(runs.map((run) => run.state)).toEqual(['canceled']);
    // A repeated resolution has nothing left to invalidate.
    expect(
      await resolveOncallAlert(
        rt,
        { groupKey: request.groupKey, principal: GATE },
        '2026-11-14T10:06:00.000Z',
      ),
    ).toEqual({ workId, invalidated: false });
  });

  it('reads an unknown or foreign group exactly like nothing to invalidate', async () => {
    const rt = runtime();
    await admitOncallAlert(rt, request);
    expect(
      await resolveOncallAlert(rt, {
        groupKey: 'page:Unknown',
        principal: GATE,
      }),
    ).toEqual({ invalidated: false });
    expect(
      await resolveOncallAlert(rt, {
        groupKey: request.groupKey,
        principal: 'svc:other-gate',
      }),
    ).toEqual({ invalidated: false });
  });
});
