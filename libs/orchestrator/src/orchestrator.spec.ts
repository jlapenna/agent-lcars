import { describe, expect, it } from 'vitest';

import { isRefusal } from './decide';
import { MemoryStore } from './memory-store';
import type { TaskId } from './model';
import { Orchestrator } from './orchestrator';

const TASK: TaskId = { repo: 'octo/example', issue: 7 };
const T0 = '2026-08-15T12:00:00.000Z';

class Clock {
  constructor(private value: string) {}
  now(): string {
    return this.value;
  }
  set(value: string): void {
    this.value = value;
  }
  advanceMinutes(minutes: number): void {
    this.value = new Date(
      Date.parse(this.value) + minutes * 60_000,
    ).toISOString();
  }
}

function fixture() {
  const clock = new Clock(T0);
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, clock);
  return { clock, store, orchestrator };
}

async function started(orchestrator: Orchestrator, requestId = 'req-1') {
  const outcome = await orchestrator.request({
    taskId: TASK,
    requestId,
    pipeline: 'claude',
  });
  if (isRefusal(outcome))
    throw new Error(`unexpected refusal: ${outcome.reason}`);
  return outcome;
}

describe('the per-task mutex', () => {
  it('starts a run and enqueues its dispatch when the task is free', async () => {
    const { store, orchestrator } = fixture();
    const outcome = await started(orchestrator);
    expect(outcome.run.state).toBe('pending');
    expect(outcome.task.activeRunId).toBe(outcome.run.runId);
    expect(outcome.outbox).toEqual([
      expect.objectContaining({ kind: 'dispatch-run', state: 'pending' }),
    ]);
    expect(await store.readActiveRun(TASK)).toMatchObject({
      runId: outcome.run.runId,
    });
  });

  it('refuses a second request while a run is live', async () => {
    const { orchestrator } = fixture();
    await started(orchestrator, 'req-1');
    const second = await orchestrator.request({
      taskId: TASK,
      requestId: 'req-2',
      pipeline: 'claude',
    });
    expect(second).toMatchObject({ refused: true, reason: 'task-busy' });
  });

  it('maps a retried request to the existing run instead of a new one', async () => {
    const { orchestrator } = fixture();
    const first = await started(orchestrator, 'req-1');
    const retry = await orchestrator.request({
      taskId: TASK,
      requestId: 'req-1',
      pipeline: 'claude',
    });
    expect(retry).toMatchObject({
      refused: true,
      reason: 'duplicate-request',
      existingRun: expect.objectContaining({ runId: first.run.runId }),
    });
  });

  it('allows the same task to be worked again after each terminal state', async () => {
    const { clock, orchestrator } = fixture();
    // finished → free
    const first = await started(orchestrator, 'req-1');
    await orchestrator.confirmDispatch(first.run.runId);
    await orchestrator.report(first.run.runId, { ok: true });
    const second = await started(orchestrator, 'req-2');
    expect(second.run.runId).not.toBe(first.run.runId);
    // canceled → free
    await orchestrator.cancel(second.run.runId, 'operator said stop');
    const third = await started(orchestrator, 'req-3');
    // lost → free
    clock.advanceMinutes(121);
    await orchestrator.sweepExpired();
    const fourth = await started(orchestrator, 'req-4');
    expect(fourth.run.runId).not.toBe(third.run.runId);
  });

  it('mints sequential, task-scoped run ids', async () => {
    const { orchestrator } = fixture();
    const first = await started(orchestrator, 'req-1');
    await orchestrator.report(first.run.runId, { ok: true });
    const second = await started(orchestrator, 'req-2');
    expect(first.run.runId).toBe('octo/example#7/r1');
    expect(second.run.runId).toBe('octo/example#7/r2');
  });
});

describe('the run lifecycle', () => {
  it('records the full transition history on the run', async () => {
    const { orchestrator } = fixture();
    const { run } = await started(orchestrator);
    await orchestrator.confirmDispatch(run.runId);
    const outcome = await orchestrator.report(run.runId, {
      ok: true,
      ref: 'https://github.com/octo/example/pull/9',
    });
    if (isRefusal(outcome)) throw new Error('unexpected refusal');
    expect(
      outcome.run.events.map((event) => `${event.to}:${event.by}`),
    ).toEqual(['pending:request', 'running:dispatch', 'finished:report']);
    expect(outcome.run.result).toEqual({
      ok: true,
      ref: 'https://github.com/octo/example/pull/9',
    });
  });

  it('treats a repeated dispatch confirmation as idempotent', async () => {
    const { orchestrator } = fixture();
    const { run } = await started(orchestrator);
    await orchestrator.confirmDispatch(run.runId);
    const again = await orchestrator.confirmDispatch(run.runId);
    if (isRefusal(again)) throw new Error('unexpected refusal');
    expect(again.run.events.filter((e) => e.to === 'running')).toHaveLength(1);
  });

  it('records the result verbatim and releases the lock on report', async () => {
    const { store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    const outcome = await orchestrator.report(run.runId, {
      ok: false,
      summary: 'agent exited nonzero',
    });
    if (isRefusal(outcome)) throw new Error('unexpected refusal');
    expect(outcome.task.activeRunId).toBeUndefined();
    expect(outcome.outbox).toEqual([
      expect.objectContaining({ kind: 'report-outcome' }),
    ]);
    expect(await store.readActiveRun(TASK)).toBeUndefined();
  });

  it('refuses a report against a settled run without changing it', async () => {
    const { store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    await orchestrator.report(run.runId, { ok: true });
    const again = await orchestrator.report(run.runId, { ok: false });
    expect(again).toMatchObject({ refused: true, reason: 'run-not-live' });
    expect((await store.readRun(run.runId))?.result).toEqual({ ok: true });
  });

  it('refuses operations on an unknown run', async () => {
    const { orchestrator } = fixture();
    for (const outcome of [
      await orchestrator.confirmDispatch('nope'),
      await orchestrator.renew('nope'),
      await orchestrator.report('nope', { ok: true }),
      await orchestrator.cancel('nope'),
    ]) {
      expect(outcome).toMatchObject({ refused: true, reason: 'unknown-run' });
    }
  });
});

describe('leases and loss', () => {
  it('a renewed run survives the sweep; an unrenewed one is lost', async () => {
    const { clock, orchestrator } = fixture();
    const kept = await started(orchestrator, 'req-1');
    await orchestrator.confirmDispatch(kept.run.runId);
    clock.advanceMinutes(80);
    await orchestrator.renew(kept.run.runId);
    clock.advanceMinutes(80); // 160m total; renewal at 80m covers to 200m
    const settled = await orchestrator.sweepExpired();
    expect(settled).toEqual([]);
  });

  it('marks an expired run lost, releases the lock, and reports onward', async () => {
    const { clock, store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    clock.advanceMinutes(121);
    const settled = await orchestrator.sweepExpired();
    expect(settled.map((r) => r.state)).toEqual(['lost']);
    expect(await store.readActiveRun(TASK)).toBeUndefined();
    const events = (await store.readRun(run.runId))?.events ?? [];
    expect(events.at(-1)).toMatchObject({ to: 'lost', by: 'expiry' });
  });

  it('does not start a replacement run for a lost one', async () => {
    const { clock, store, orchestrator } = fixture();
    await started(orchestrator);
    clock.advanceMinutes(121);
    await orchestrator.sweepExpired();
    expect(await store.listRuns(TASK)).toHaveLength(1);
  });

  it('refuses a late report from a run that already lost the lock', async () => {
    const { clock, orchestrator } = fixture();
    const stale = await started(orchestrator, 'req-1');
    clock.advanceMinutes(121);
    await orchestrator.sweepExpired();
    const late = await orchestrator.report(stale.run.runId, { ok: true });
    expect(late).toMatchObject({ refused: true, reason: 'run-not-live' });
  });

  it('never lets a stale run overwrite its successor', async () => {
    const { clock, store, orchestrator } = fixture();
    const stale = await started(orchestrator, 'req-1');
    clock.advanceMinutes(121);
    await orchestrator.sweepExpired();
    const fresh = await started(orchestrator, 'req-2');
    const late = await orchestrator.renew(stale.run.runId);
    expect(isRefusal(late)).toBe(true);
    expect((await store.readActiveRun(TASK))?.runId).toBe(fresh.run.runId);
  });

  it('sweeping twice settles a run only once', async () => {
    const { clock, orchestrator } = fixture();
    await started(orchestrator);
    clock.advanceMinutes(121);
    const first = await orchestrator.sweepExpired();
    const second = await orchestrator.sweepExpired();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});

describe('the outbox', () => {
  it('hands out pending entries once and settles them', async () => {
    const { store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    await orchestrator.report(run.runId, { ok: true });
    const claimed = await store.claimPendingOutbox(10);
    expect(claimed.map((entry) => entry.kind).sort()).toEqual([
      'dispatch-run',
      'report-outcome',
    ]);
    for (const entry of claimed)
      await store.settleOutbox(entry.entryId, 'done');
    expect(await store.claimPendingOutbox(10)).toEqual([]);
  });
});

describe('concurrency', () => {
  it('exactly one of two racing requests wins the lock', async () => {
    const { orchestrator } = fixture();
    const [a, b] = await Promise.all([
      orchestrator.request({
        taskId: TASK,
        requestId: 'req-a',
        pipeline: 'claude',
      }),
      orchestrator.request({
        taskId: TASK,
        requestId: 'req-b',
        pipeline: 'claude',
      }),
    ]);
    const refusals = [a, b].filter(isRefusal);
    const wins = [a, b].filter((o) => !isRefusal(o));
    expect(wins).toHaveLength(1);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ reason: 'task-busy' });
  });
});
