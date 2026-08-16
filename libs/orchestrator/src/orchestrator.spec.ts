import { describe, expect, it } from 'vitest';

import {
  type Decision,
  isQueued,
  isRefusal,
  type Queued,
  type Refusal,
} from './decide';
import { MemoryStore } from './memory-store';
import type { TaskId } from './model';
import { Orchestrator, type RequestInput } from './orchestrator';

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

/** Test double for exercising `sweepExpired`'s refusal-handling branch: on
 *  its first retry request (`requestId` starting with `retry:`), runs an
 *  injected side effect *before* delegating to the real `request()` -- used
 *  to simulate an operator's manual request landing in the narrow window
 *  between the expire commit and the auto-retry's own request, so that
 *  request observably loses the race. */
class RacingOrchestrator extends Orchestrator {
  #armed = true;
  readonly #race: () => Promise<void>;

  constructor(
    ...args: [
      ...ConstructorParameters<typeof Orchestrator>,
      () => Promise<void>,
    ]
  ) {
    const [store, clock, race] = args;
    super(store, clock);
    this.#race = race;
  }

  // Mirrors `Orchestrator.request`'s own three overloads exactly -- a
  // single (widened) override signature isn't assignable to an overloaded
  // base method, since TS checks the override against each of the base's
  // declared overloads, including their narrower per-shape return types.
  override request(
    input: RequestInput & { queueIfBusy?: false },
  ): Promise<Decision | Refusal>;
  override request(
    input: RequestInput & { queueIfBusy: true },
  ): Promise<Decision | Refusal | Queued>;
  override request(input: RequestInput): Promise<Decision | Refusal | Queued>;
  override async request(
    input: RequestInput,
  ): Promise<Decision | Refusal | Queued> {
    if (this.#armed && input.requestId.startsWith('retry:')) {
      this.#armed = false;
      await this.#race();
    }
    return super.request(input);
  }
}

async function started(
  orchestrator: Orchestrator,
  requestId = 'req-1',
  params?: Record<string, string>,
) {
  const outcome = await orchestrator.request({
    taskId: TASK,
    requestId,
    pipeline: 'claude',
    ...(params === undefined ? {} : { params }),
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
    // lost → each loss auto-retries until the budget (MAX_AUTO_RETRIES = 2)
    // is exhausted, which is when the task is actually free again.
    for (let i = 0; i < 3; i++) {
      clock.advanceMinutes(121);
      await orchestrator.sweepExpired();
    }
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
    expect(settled).toEqual({ lost: [], retried: [] });
  });

  it('marks an expired run lost, reports onward, and hands the freed lock to its auto-retry', async () => {
    const { clock, store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    clock.advanceMinutes(121);
    const settled = await orchestrator.sweepExpired();
    expect(settled.lost.map((r) => r.state)).toEqual(['lost']);
    const events = (await store.readRun(run.runId))?.events ?? [];
    expect(events.at(-1)).toMatchObject({ to: 'lost', by: 'expiry' });
    // The lock is released and immediately re-acquired by the auto-retry,
    // not left free -- see the 'auto-retry on loss' tests below for the
    // budget-exhausted case where it actually stays free.
    const activeRun = await store.readActiveRun(TASK);
    expect(activeRun?.runId).toBe(settled.retried[0]?.newRunId);
  });

  it('starts exactly one replacement run for a lost one, within budget', async () => {
    const { clock, store, orchestrator } = fixture();
    await started(orchestrator);
    clock.advanceMinutes(121);
    const swept = await orchestrator.sweepExpired();
    expect(swept.retried).toHaveLength(1);
    expect(await store.listRuns(TASK)).toHaveLength(2); // the lost run + its retry
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
    // The task's lock is immediately handed to the auto-retry -- that's
    // the "successor" here, not a manual re-request (which would now be
    // refused as task-busy while the retry is live).
    const swept = await orchestrator.sweepExpired();
    const freshRunId = swept.retried[0]?.newRunId;
    if (freshRunId === undefined) throw new Error('expected an auto-retry');
    const late = await orchestrator.renew(stale.run.runId);
    expect(isRefusal(late)).toBe(true);
    expect((await store.readActiveRun(TASK))?.runId).toBe(freshRunId);
  });

  it('sweeping twice settles a run (and its auto-retry) only once', async () => {
    const { clock, orchestrator } = fixture();
    await started(orchestrator);
    clock.advanceMinutes(121);
    const first = await orchestrator.sweepExpired();
    const second = await orchestrator.sweepExpired();
    expect(first.lost).toHaveLength(1);
    expect(first.retried).toHaveLength(1);
    expect(second.lost).toHaveLength(0);
    expect(second.retried).toHaveLength(0);
  });
});

describe('auto-retry on loss', () => {
  it('starts a fresh run for the same task, copying pipeline and params verbatim, and increments consecutiveLost', async () => {
    const { clock, store, orchestrator } = fixture();
    const { run } = await started(orchestrator, 'req-1', {
      mode: 'reply',
      reply: 'hi',
    });
    clock.advanceMinutes(121);
    const swept = await orchestrator.sweepExpired();

    expect(swept.lost.map((r) => r.state)).toEqual(['lost']);
    expect(swept.retried).toHaveLength(1);
    expect(swept.retried[0]?.lostRunId).toBe(run.runId);
    const newRunId = swept.retried[0]?.newRunId as string;

    const newRun = await store.readRun(newRunId);
    expect(newRun?.requestId).toBe(`retry:${run.runId}`);
    expect(newRun?.pipeline).toBe(run.pipeline);
    expect(newRun?.params).toEqual(run.params);
    expect(newRun?.state).toBe('pending');

    const task = await store.readTask(TASK);
    expect(task?.task.activeRunId).toBe(newRunId);
    expect(task?.task.consecutiveLost).toBe(1);
  });

  it('cannot be double-retried by a re-sweep or crash-retry: the deterministic requestId maps back to the same run', async () => {
    const { clock, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    clock.advanceMinutes(121);
    const swept = await orchestrator.sweepExpired();
    const newRunId = swept.retried[0]?.newRunId as string;

    // Simulates a re-sweep or crash-retry landing on the same lost run:
    // issuing the exact same retry request again maps to the run already
    // created instead of starting a third one.
    const again = await orchestrator.request({
      taskId: TASK,
      requestId: `retry:${run.runId}`,
      pipeline: run.pipeline,
      ...(run.params === undefined ? {} : { params: run.params }),
    });
    expect(again).toMatchObject({
      refused: true,
      reason: 'duplicate-request',
      existingRun: expect.objectContaining({ runId: newRunId }),
    });

    // A second sweepExpired call (nothing newly expired) retries nothing
    // further either.
    const secondSweep = await orchestrator.sweepExpired();
    expect(secondSweep.lost).toEqual([]);
    expect(secondSweep.retried).toEqual([]);
  });

  it('stops retrying once a task has lost 3 runs in a row (budget exhausted)', async () => {
    const { clock, store, orchestrator } = fixture();
    await started(orchestrator, 'req-1');
    for (let i = 0; i < 2; i++) {
      clock.advanceMinutes(121);
      const swept = await orchestrator.sweepExpired();
      expect(swept.retried).toHaveLength(1);
    }
    // Third consecutive loss: budget (MAX_AUTO_RETRIES = 2) exhausted.
    clock.advanceMinutes(121);
    const finalSweep = await orchestrator.sweepExpired();
    expect(finalSweep.lost).toHaveLength(1);
    expect(finalSweep.retried).toEqual([]);

    const task = await store.readTask(TASK);
    expect(task?.task.consecutiveLost).toBe(3);
    expect(task?.task.activeRunId).toBeUndefined();
    expect(await store.listRuns(TASK)).toHaveLength(3);
  });

  it('resets the budget once a retried run finishes, so a later loss retries again', async () => {
    const { clock, orchestrator } = fixture();
    await started(orchestrator);
    clock.advanceMinutes(121);
    const swept = await orchestrator.sweepExpired();
    const retriedRunId = swept.retried[0]?.newRunId as string;

    await orchestrator.confirmDispatch(retriedRunId);
    const reportOutcome = await orchestrator.report(retriedRunId, {
      ok: true,
    });
    if (isRefusal(reportOutcome)) throw new Error('unexpected refusal');

    // A brand-new request, then loss, retries again -- proving the earlier
    // loss no longer counts against the budget.
    const fresh = await started(orchestrator, 'req-2');
    clock.advanceMinutes(121);
    const secondSweep = await orchestrator.sweepExpired();
    expect(secondSweep.retried).toHaveLength(1);
    expect(secondSweep.retried[0]?.lostRunId).toBe(fresh.run.runId);
  });

  it('treats a refused retry as fine when an operator races it and wins: no duplicate run', async () => {
    const { clock, store } = fixture();
    const manualOrchestrator = new Orchestrator(store, clock);
    const orchestrator = new RacingOrchestrator(store, clock, async () => {
      // The operator's manual re-request lands first, in the narrow
      // window between the expire commit and the auto-retry's own
      // request -- so the auto-retry below finds the task already busy.
      const manual = await manualOrchestrator.request({
        taskId: TASK,
        requestId: 'manual-race',
        pipeline: 'claude',
      });
      if (isRefusal(manual)) {
        throw new Error('test setup: manual race request unexpectedly refused');
      }
    });

    const { run } = await started(orchestrator, 'req-1');
    clock.advanceMinutes(121);
    const swept = await orchestrator.sweepExpired();

    expect(swept.lost.map((r) => r.runId)).toEqual([run.runId]);
    expect(swept.retried).toEqual([]); // refused: no retry recorded

    const task = await store.readTask(TASK);
    const activeRunId = task?.task.activeRunId;
    expect(activeRunId).toBeDefined();
    const activeRun =
      activeRunId === undefined ? undefined : await store.readRun(activeRunId);
    expect(activeRun?.requestId).toBe('manual-race'); // the operator's run won
    expect(await store.listRuns(TASK)).toHaveLength(2); // original + operator's
  });
});

describe('queueing (opt-in)', () => {
  it('refuses a busy task by default -- queueIfBusy unset -- exactly as before', async () => {
    const { store, orchestrator } = fixture();
    await started(orchestrator, 'req-1');
    const second = await orchestrator.request({
      taskId: TASK,
      requestId: 'req-2',
      pipeline: 'claude',
    });
    expect(second).toMatchObject({ refused: true, reason: 'task-busy' });
    expect((await store.readTask(TASK))?.task.pendingRequest).toBeUndefined();
  });

  it('queues a request against a busy task instead of refusing it, when asked', async () => {
    const { store, orchestrator } = fixture();
    const first = await started(orchestrator, 'req-1');
    const queued = await orchestrator.request({
      taskId: TASK,
      requestId: 'req-2',
      pipeline: 'codex',
      params: { mode: 'reply' },
      queueIfBusy: true,
    });
    expect(isQueued(queued)).toBe(true);
    if (!isQueued(queued)) throw new Error('expected queued outcome');
    expect(queued.task.pendingRequest).toEqual({
      requestId: 'req-2',
      pipeline: 'codex',
      params: { mode: 'reply' },
    });
    // No run was started for the queued request: the live run is untouched
    // and it's the only run that exists so far.
    expect(queued.task.activeRunId).toBe(first.run.runId);
    expect(await store.listRuns(TASK)).toHaveLength(1);
    expect(await store.readTask(TASK)).toMatchObject({
      task: { pendingRequest: queued.task.pendingRequest },
    });
  });

  it('still maps same-requestId dedup to the live run first, even with queueIfBusy set', async () => {
    const { orchestrator } = fixture();
    const first = await started(orchestrator, 'req-1');
    const outcome = await orchestrator.request({
      taskId: TASK,
      requestId: 'req-1',
      pipeline: 'claude',
      queueIfBusy: true,
    });
    expect(outcome).toMatchObject({
      refused: true,
      reason: 'duplicate-request',
      existingRun: expect.objectContaining({ runId: first.run.runId }),
    });
    expect(isQueued(outcome)).toBe(false);
  });

  it('replaces an earlier queued request with a later one -- last-write-wins, not a queue of queues', async () => {
    const { store, orchestrator } = fixture();
    await started(orchestrator, 'req-1');
    await orchestrator.request({
      taskId: TASK,
      requestId: 'req-2',
      pipeline: 'codex',
      queueIfBusy: true,
    });
    const second = await orchestrator.request({
      taskId: TASK,
      requestId: 'req-3',
      pipeline: 'opencode',
      params: { mode: 'reply' },
      queueIfBusy: true,
    });
    expect(isQueued(second)).toBe(true);
    if (!isQueued(second)) throw new Error('expected queued outcome');
    expect(second.task.pendingRequest).toEqual({
      requestId: 'req-3',
      pipeline: 'opencode',
      params: { mode: 'reply' },
    });
    expect((await store.readTask(TASK))?.task.pendingRequest?.requestId).toBe(
      'req-3',
    );
  });

  it('consumes the queued request into a fresh run atomically when the live run finishes', async () => {
    const { store, orchestrator } = fixture();
    const first = await started(orchestrator, 'req-1');
    await orchestrator.request({
      taskId: TASK,
      requestId: 'req-2',
      pipeline: 'codex',
      params: { mode: 'reply' },
      queueIfBusy: true,
    });

    const outcome = await orchestrator.report(first.run.runId, { ok: true });
    if (isRefusal(outcome)) throw new Error('unexpected refusal');
    expect(outcome.followUpRun).toMatchObject({
      requestId: 'req-2',
      pipeline: 'codex',
      params: { mode: 'reply' },
      state: 'pending',
    });
    expect(outcome.task.activeRunId).toBe(outcome.followUpRun?.runId);
    expect(outcome.task.pendingRequest).toBeUndefined();
    // Atomic: the settled run, the follow-up run, and its dispatch outbox
    // entry all landed together with the task update.
    expect(await store.readRun(outcome.followUpRun?.runId as string)).toEqual(
      outcome.followUpRun,
    );
    expect((await store.readActiveRun(TASK))?.runId).toBe(
      outcome.followUpRun?.runId,
    );
    // Both dispatch-run entries (the original request's, still unclaimed,
    // and the follow-up run's) plus the settled run's report-outcome.
    const outboxKinds = (await store.claimPendingOutbox(10))
      .map((entry) => entry.kind)
      .sort();
    expect(outboxKinds).toEqual([
      'dispatch-run',
      'dispatch-run',
      'report-outcome',
    ]);
  });

  it('consumes the queued request into a fresh run atomically when the live run is canceled', async () => {
    const { store, orchestrator } = fixture();
    const first = await started(orchestrator, 'req-1');
    await orchestrator.request({
      taskId: TASK,
      requestId: 'req-2',
      pipeline: 'codex',
      queueIfBusy: true,
    });

    const outcome = await orchestrator.cancel(first.run.runId, 'stop');
    if (isRefusal(outcome)) throw new Error('unexpected refusal');
    expect(outcome.followUpRun?.requestId).toBe('req-2');
    expect(outcome.task.activeRunId).toBe(outcome.followUpRun?.runId);
    expect(outcome.task.pendingRequest).toBeUndefined();
    expect(await store.listRuns(TASK)).toHaveLength(2);
  });

  it('consumes the queued request into a fresh run atomically when the live run is lost, and it beats the auto-retry', async () => {
    const { clock, store, orchestrator } = fixture();
    const { run } = await started(orchestrator, 'req-1');
    await orchestrator.request({
      taskId: TASK,
      requestId: 'req-2',
      pipeline: 'codex',
      queueIfBusy: true,
    });

    clock.advanceMinutes(121);
    const swept = await orchestrator.sweepExpired();

    expect(swept.lost.map((r) => r.runId)).toEqual([run.runId]);
    // The auto-retry's own request found the task already busy (the queued
    // request's follow-up run took the lock first, in the same decision as
    // the loss) and was refused -- so sweepExpired recorded no retry.
    expect(swept.retried).toEqual([]);

    const task = await store.readTask(TASK);
    expect(task?.task.pendingRequest).toBeUndefined();
    const activeRun = await store.readActiveRun(TASK);
    expect(activeRun?.requestId).toBe('req-2'); // the queued request won
    expect(activeRun?.pipeline).toBe('codex');
    // consecutiveLost still carries over into the follow-up run's task,
    // same as it would for any other request racing an expired lease.
    expect(task?.task.consecutiveLost).toBe(1);
    expect(await store.listRuns(TASK)).toHaveLength(2); // lost + queued follow-up
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
