import { describe, expect, it } from 'vitest';

import { decidedRun, isRefusal } from './decide';
import { MemoryStore } from './memory-store';
import type { TaskId } from './model';
import { Orchestrator, type RequestInput } from './orchestrator';
import { OUTBOX_LEASE_MS } from './store';

const TASK: TaskId = { repo: 'octo/example', issue: 7 };
const WORK: TaskId = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' };
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

function claimOutbox(store: MemoryStore, now = T0, limit = 10) {
  return store.claimPendingOutbox({
    limit,
    now,
    leaseExpiresAt: new Date(Date.parse(now) + OUTBOX_LEASE_MS).toISOString(),
  });
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

  override async request(input: RequestInput) {
    if (this.#armed && input.requestId.startsWith('retry:')) {
      this.#armed = false;
      await this.#race();
    }
    return super.request(input);
  }
}

/** `request()` always mints a run, so callers can rely on `.run` directly
 *  instead of narrowing it at every call site. */
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
  return { ...outcome, run: decidedRun(outcome) };
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

  it('atomically maps overlapping same-id requests to one run', async () => {
    const { store, orchestrator } = fixture();
    const input = {
      taskId: TASK,
      requestId: 'same-request',
      pipeline: 'claude',
    };
    const [left, right] = await Promise.all([
      orchestrator.request(input),
      orchestrator.request(input),
    ]);

    const outcomes = [left, right];
    const accepted = outcomes.find((outcome) => !isRefusal(outcome));
    const duplicate = outcomes.find(
      (outcome) => isRefusal(outcome) && outcome.reason === 'duplicate-request',
    );
    if (accepted === undefined || isRefusal(accepted)) {
      throw new Error('expected one accepted request');
    }
    expect(duplicate).toMatchObject({
      refused: true,
      reason: 'duplicate-request',
      existingRun: expect.objectContaining({
        runId: decidedRun(accepted).runId,
      }),
    });
    expect(await store.listRuns(TASK)).toHaveLength(1);
  });

  it('returns a terminal request-id match even when a newer run holds the lock', async () => {
    const { store, orchestrator } = fixture();
    const first = await started(orchestrator, 'retry-after-settlement');
    await orchestrator.report(first.run.runId, { ok: true });
    await started(orchestrator, 'newer-request');

    const replay = await orchestrator.request({
      taskId: TASK,
      requestId: 'retry-after-settlement',
      pipeline: 'claude',
    });
    expect(replay).toMatchObject({
      refused: true,
      reason: 'duplicate-request',
      existingRun: expect.objectContaining({ runId: first.run.runId }),
    });
    expect(await store.listRuns(TASK)).toHaveLength(2);
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
    const settledRun = decidedRun(outcome);
    expect(settledRun.events.map((event) => `${event.to}:${event.by}`)).toEqual(
      ['pending:request', 'running:dispatch', 'finished:report'],
    );
    expect(settledRun.result).toEqual({
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
    expect(
      decidedRun(again).events.filter((e) => e.to === 'running'),
    ).toHaveLength(1);
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
      requestSource: 'auto-retry',
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

  it('keeps automatic retry history separate from a caller key that looks internal', async () => {
    const { clock, store, orchestrator } = fixture();
    // Caller input is intentionally arbitrary. This is exactly the key the
    // first run's lease-expiry retry will later use, but in the caller
    // namespace rather than the orchestrator's internal retry namespace.
    const { run } = await started(orchestrator, 'retry:octo/example#7/r1');
    clock.advanceMinutes(121);

    const swept = await orchestrator.sweepExpired();
    expect(swept.retried).toHaveLength(1);
    const retry = await store.readRun(swept.retried[0]?.newRunId as string);
    expect(retry).toMatchObject({
      requestId: `retry:${run.runId}`,
      requestSource: 'auto-retry',
    });

    // Replaying the caller's original key remains idempotent against its
    // original run; it cannot be confused with the automatic retry.
    const replay = await orchestrator.request({
      taskId: TASK,
      requestId: `retry:${run.runId}`,
      pipeline: run.pipeline,
    });
    expect(replay).toMatchObject({
      refused: true,
      reason: 'duplicate-request',
      existingRun: expect.objectContaining({ runId: run.runId }),
    });
  });

  it('does not classify a first caller request as a live automatic retry duplicate', async () => {
    const { clock, store, orchestrator } = fixture();
    const original = await started(orchestrator, 'ordinary-request');
    clock.advanceMinutes(121);
    const swept = await orchestrator.sweepExpired();
    const automaticRunId = swept.retried[0]?.newRunId as string;
    const callerKey = `retry:${original.run.runId}`;

    const whileAutomaticIsLive = await orchestrator.request({
      taskId: TASK,
      requestId: callerKey,
      pipeline: original.run.pipeline,
    });
    expect(whileAutomaticIsLive).toMatchObject({
      refused: true,
      reason: 'task-busy',
      existingRun: expect.objectContaining({ runId: automaticRunId }),
    });

    await orchestrator.report(automaticRunId, { ok: true });
    const callerRun = await orchestrator.request({
      taskId: TASK,
      requestId: callerKey,
      pipeline: original.run.pipeline,
    });
    if (isRefusal(callerRun)) throw new Error('caller request was refused');
    const callerRunId = decidedRun(callerRun).runId;
    expect((await store.readRun(callerRunId))?.requestSource).toBe('caller');

    const replay = await orchestrator.request({
      taskId: TASK,
      requestId: callerKey,
      pipeline: original.run.pipeline,
    });
    expect(replay).toMatchObject({
      refused: true,
      reason: 'duplicate-request',
      existingRun: expect.objectContaining({ runId: callerRunId }),
    });
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

  it('a lost run auto-retries', async () => {
    const { store, orchestrator, clock } = fixture();
    const requested = await orchestrator.request({
      taskId: WORK,
      requestId: 'req-1',
      pipeline: 'claude',
    });
    if (isRefusal(requested)) throw new Error('unexpected refusal');
    const runId = decidedRun(requested).runId;
    await orchestrator.confirmDispatch(runId);
    // Past LEASE_MS (2h) so sweepExpired treats it as lost.
    clock.advanceMinutes(121);
    const swept = await orchestrator.sweepExpired();
    expect(swept.retried).toHaveLength(1);
    expect(await store.readRun(swept.retried[0]!.newRunId)).toMatchObject({
      state: 'pending',
    });
  });
});

describe('the outbox', () => {
  it('hands out pending entries once and settles them', async () => {
    const { clock, store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    await orchestrator.report(run.runId, { ok: true });
    const claimed = await claimOutbox(store, clock.now());
    expect(claimed.map((entry) => entry.kind).sort()).toEqual([
      'dispatch-run',
      'report-outcome',
    ]);
    for (const entry of claimed) {
      await store.settleOutbox({
        entryId: entry.entryId,
        claimId: entry.claimId,
        state: 'done',
        now: clock.now(),
      });
    }
    expect(await claimOutbox(store, clock.now())).toEqual([]);
  });
});

describe('native anchors', () => {
  it('creates the task with its work payload on first request', async () => {
    const { orchestrator, store } = fixture();
    const work = {
      origin: { principal: 'user:jlapenna' },
      spec: { title: 'x' },
    };
    const outcome = await orchestrator.request({
      taskId: WORK,
      requestId: WORK.workId,
      pipeline: 'claude',
      work,
    });
    expect(isRefusal(outcome)).toBe(false);
    const stored = await store.readTask(WORK);
    expect(stored?.task.work).toEqual(work);
    expect(stored?.task.activeRunId).toBe(`work:${WORK.workId}/r1`);
  });

  it('does not overwrite work on a later request for the same task', async () => {
    const { orchestrator, store } = fixture();
    await orchestrator.request({
      taskId: WORK,
      requestId: 'r1',
      pipeline: 'claude',
      work: { spec: { title: 'first' } },
    });
    const replay = await orchestrator.request({
      taskId: WORK,
      requestId: 'r1',
      pipeline: 'claude',
    });
    expect(replay).toMatchObject({
      refused: true,
      reason: 'duplicate-request',
    });
    await orchestrator.report(`work:${WORK.workId}/r1`, { ok: false });
    await orchestrator.request({
      taskId: WORK,
      requestId: 'r2',
      pipeline: 'claude',
      work: { spec: { title: 'second' } },
    });
    const stored = await store.readTask(WORK);
    expect(stored?.task.work).toEqual({ spec: { title: 'first' } });
    expect(stored?.task.activeRunId).toBe(`work:${WORK.workId}/r2`);
  });

  it('refuses a request on a closed task', async () => {
    const { orchestrator } = fixture();
    await orchestrator.request({
      taskId: WORK,
      requestId: 'r1',
      pipeline: 'claude',
      work: {},
    });
    await orchestrator.report(`work:${WORK.workId}/r1`, { ok: false });
    const closed = await orchestrator.close(WORK);
    expect(isRefusal(closed)).toBe(false);
    const again = await orchestrator.request({
      taskId: WORK,
      requestId: 'r2',
      pipeline: 'claude',
    });
    expect(again).toMatchObject({ refused: true, reason: 'task-closed' });
  });
});

describe('GitHub anchors', () => {
  // `requestRun` (decide.ts) stores `work` for any anchor, not only native
  // ones -- console-side derivation (sub-project 5) populates it for a
  // GitHub-anchored task the same way it always has for a native one.
  it('stores a work payload on first request, same as a native anchor', async () => {
    const { orchestrator, store } = fixture();
    const work = {
      origin: { principal: 'github:jlapenna', channel: 'github' },
      spec: {
        title: 'Fix the thing',
        description: 'Please fix it.',
        pipeline: 'claude',
        target: { repo: 'octo/example' },
      },
    };
    const outcome = await orchestrator.request({
      taskId: TASK,
      requestId: 'req-1',
      pipeline: 'claude',
      work,
    });
    expect(isRefusal(outcome)).toBe(false);
    const stored = await store.readTask(TASK);
    expect(stored?.task.work).toEqual(work);
  });
});

describe('close', () => {
  it('refuses while a run is live', async () => {
    const { orchestrator } = fixture();
    await orchestrator.request({
      taskId: WORK,
      requestId: 'r1',
      pipeline: 'claude',
      work: {},
    });
    expect(await orchestrator.close(WORK)).toMatchObject({
      refused: true,
      reason: 'task-busy',
    });
  });

  it('sets closedAt once no run is live and is idempotent', async () => {
    const { orchestrator, store } = fixture();
    await orchestrator.request({
      taskId: WORK,
      requestId: 'r1',
      pipeline: 'claude',
      work: {},
    });
    await orchestrator.report(`work:${WORK.workId}/r1`, { ok: false });
    const first = await orchestrator.close(WORK);
    expect(isRefusal(first)).toBe(false);
    expect((await store.readTask(WORK))?.task.closedAt).toBe(T0);
    expect(await orchestrator.close(WORK)).toMatchObject({
      refused: true,
      reason: 'task-closed',
    });
  });

  it('refuses a task that was never created', async () => {
    const { orchestrator } = fixture();
    expect(await orchestrator.close(WORK)).toMatchObject({
      refused: true,
      reason: 'unknown-task',
    });
  });

  it('refuses a GitHub-anchored task: closedAt is native anchors only', async () => {
    const { orchestrator } = fixture();
    await started(orchestrator);
    expect(await orchestrator.close(TASK)).toMatchObject({
      refused: true,
      reason: 'not-native',
    });
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
